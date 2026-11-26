import { randomUUID } from "node:crypto";
import { buildDistributionContext, canContinueWithoutHealing, compactDistributionPlan } from "./distribution-context.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function warningEnvironmentKey(snapshot = {}) {
  const status = snapshot.status || {};
  const position = Array.isArray(status.pos) ? status.pos.map(value => Math.floor(Number(value) || 0)) : null;
  const inventory = (snapshot.inventory?.items || []).map(item => [item.name, Number(item.count) || 0]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify([status.dimension || null, position, inventory]);
}

export const SCRIPT_CATALOG = {
  explore_cave: { caveId: "由入口命名并复用", maxNodes: 160, targets: [{ item: "diamond", count: 4 }, { item: "obsidian", count: 4 }], minXpLevel: 30 },
  gather_resources: { surveyId: "地表资源区", maxNodes: 160, targets: [{ item: "sugar_cane", count: 138 }, { item: "leather", count: 46 }], note: "targets填产物名；leather由C++搜索牛/马等动物，甘蔗先采近处并保根" },
  build_enchanting_area: { bookshelves: 15, optional: true, maxRuntimeMs: 180000 },
  enchant_equipment: { minLevel: 30, optional: true, maxRuntimeMs: 180000 },
  chop_tree: { targetCount: 32, radius: 24, exploreSteps: 6 },
  mine_vein: { types: ["iron_ore", "deepslate_iron_ore"], targetCount: 16, note: "targetCount按掉落物背包总数计算；不要只为向上挖掘采集垫脚石" },
  collect_drops: { types: ["raw_iron"], radius: 6 },
  fishbone_mine: { laneId: "1", stopWhen: ["lane_complete", "danger", "no_tool", "inventory_full"] },
  staircase_up: { direction: "x", steps: 8 }, staircase_down: { direction: "x", steps: 8 },
  move_to: { target: [0, 64, 0], construct: false }, route_navigate: { to: "家", construct: false },
  navigation_recover: { target: [0, 64, 0] }, bridge_to: { target: [0, 64, 0], material: "cobblestone" },
  pillar: { height: 3, material: "cobblestone" }, place: { item: "furnace", pos: [0, 64, 0] }, build_workarea: { direction: "z", name: "家" },
  build_base: { name: "临时基地", material: "cobblestone", width: 5, depth: 5, wallHeight: 3 },
  build_house: { name: "小家", material: "cobblestone", width: 7, depth: 7, wallHeight: 3, style: "cottage", note: "C++断点施工：窗洞、可选玻璃窗、屋脊；材料不足只警告并保留现场" },
  workshop: { mode: "craft|smelt|store|take", items: [{ item: "stick", count: 8 }] },
  discard_items: { items: [{ item: "cobbled_deepslate", count: 64 }] },
  craft: { item: "crafting_table", count: 1 }, equip: { item: "iron_sword", slot: "hand" },
  mark_anchor: { name: "矿洞入口" }, maintain: { home: "家" }, inspect_state: {}
};
export function normalizeNativePlan(raw) {
  if (!raw || !Array.isArray(raw.tasks)) throw new Error("Distribution 必须返回 tasks 数组");
  const tasks = raw.tasks.slice(0, 8).map((task, i) => {
    if (!Array.isArray(task.actions) || task.actions.length < 1 || task.actions.length > 16) throw new Error("每个任务需含1到16个完整脚本");
    const actions = task.actions.map(action => {
      if (!Object.hasOwn(SCRIPT_CATALOG, action.type)) throw new Error(`仅允许 C++ 自动化脚本，拒绝 ${action.type}`);
      if (action.params != null && (typeof action.params !== "object" || Array.isArray(action.params))) throw new Error("脚本参数需为对象");
      return { type: action.type, params: action.params || {} };
    });
    return { id: `${task.id || `work-${i}`}-${randomUUID()}`, title: String(task.title || "自动化工作"), goal: String(task.goal || ""), failureRecovery: Boolean(task.failureRecovery), actions };
  });
  return { planId: `native-${randomUUID()}`, rationale: String(raw.rationale || ""), priorities: raw.priorities || [], tasks, createdAt: Date.now() };
}
export class NativeDistribution {
  constructor({ provider, eventBus, memory, memoryArchive, inventoryBrief = null, progressLedger = null, filePath = "data/distribution-state.json" }) {
    Object.assign(this, { provider, events: eventBus, memory, memoryArchive, inventoryBrief, progressLedger, filePath });this.debugHints = [];this.currentPlan = null;this.running = null;this.lastRunAt = 0;this.lastFailure = null;this.continuingTask = null;this.continuationProgress = null;this.resumeExact = false;this.workareaRetryAt = 0;this.workareaLastCompleted = null;this.workareaFailureKey = null;this.workareaFailureCount = 0;this.workareaBlocked = null;this.warningRetryAt = 0;this.warningFailureKey = null;this.warningFailureCount = 0;this.warningBlocked = null;this.saving = Promise.resolve();
    // Emergency scripts borrow the executor, but never own the ordinary
    // work continuation. Keep the interrupted resource job across restarts.
    const emergency = data => ["tac", "death-recovery"].includes(data.source);
    this.events.on("action-start", data => { if (!emergency(data) && data.task) { const index=data.actionIndex||0;this.continuingTask={...data.task,actions:(data.task.actions||[]).slice(index)};this.resumeExact=true;if(this.lastFailure&&this.lastFailure.taskId!==data.task.id)this.lastFailure=null;if(data.action?.type==="fishbone_mine")this.continuationProgress ||= {};this.persist(); } });
    this.events.on("action-progress", data => { if (data.action?.type === "fishbone_mine" && data.progress && ["fishbone_main", "fishbone_branch"].includes(data.progress.phase)) { this.continuationProgress = { ...this.continuationProgress, ...data.progress, direction: data.action.params?.direction || "z", updatedAt: Date.now() };this.persist(); } });
    this.events.on("action-error", data => { if (emergency(data)) return;this.lastFailure = { action: data.action, task: data.task || null, taskId: data.taskId || null, error: { code: data.error.code, message: data.error.message, details: data.error.details }, at: Date.now() };if(data.task)this.continuingTask={...data.task,actions:[data.action]};this.resumeExact=false;this.persist(); });
    this.events.on("action-warning", data => {
      if (emergency(data)) return;
      if (["work_incomplete", "workarea_incomplete", "base_incomplete"].includes(data.warning?.code) && data.task) {
        const completed = Number(data.warning.result?.completed ?? data.warning.completed);
        if (data.warning.code === "workarea_incomplete" && Number.isFinite(completed)) {
          const key = JSON.stringify(data.action?.params || {});
          if (key === this.workareaFailureKey && completed === this.workareaLastCompleted) this.workareaFailureCount++;
          else { this.workareaFailureKey = key; this.workareaFailureCount = 1; }
          this.workareaRetryAt = Date.now() + 15000;
          this.workareaLastCompleted = completed;
          if (this.workareaFailureCount >= 2) {
            this.workareaBlocked = { key, completed, checked: false, at: Date.now() };
            this.continuingTask = null; this.resumeExact = false;
            this.lastFailure = { action: data.action, task: data.task, taskId: data.taskId, error: { code: "workarea_stalled", message: "同一工作区在相同进度连续失败，已停止重复施工", details: { completed } }, warning: true, at: Date.now() };
            this.events.emit("distribution-blocked", { reason: "workarea_stalled", action: data.action, completed });
            this.persist(); return;
          }
        }
        this.lastFailure = null; this.continuingTask = { ...data.task, actions: [data.action] }; this.resumeExact = true;
      } else {
        const warning = data.warning || {}, key = JSON.stringify([data.action?.type || null, data.action?.params || {}, warning.code || "warning"]);
        if (key === this.warningFailureKey) this.warningFailureCount++; else { this.warningFailureKey = key; this.warningFailureCount = 1; }
        this.warningRetryAt = Date.now() + 15000;
        this.resumeExact = false;
        this.lastFailure = { action: data.action, task: data.task || null, taskId: data.taskId || null, error: { code: warning.code, message: warning.message, details: warning }, warning: true, at: Date.now() };
        if (this.warningFailureCount >= 2) {
          this.warningBlocked = { key, code: warning.code, checked: false, at: Date.now() };
          this.continuingTask = null;
          this.events.emit("distribution-blocked", { reason: "repeated_warning", code: warning.code, action: data.action });
        }
      }
      this.persist();
    });
    this.events.on("task-incomplete", data => { if(!emergency(data)&&data.task){this.continuingTask={...data.task,actions:[data.action]};this.continuationProgress={...(this.continuationProgress||{}),...data.result,updatedAt:Date.now()};this.resumeExact=true;this.persist();} });
    this.events.on("action-end", data => {
      if (emergency(data)) return;
      const result = data.result || {};
      if (data.action?.type === "fishbone_mine" && result.stopReason === "resume_required" && data.task) {
        this.continuingTask = { ...data.task, actions: [{ type: data.action.type, params: data.action.params || {} }] };
        this.continuationProgress = { ...(this.continuationProgress || {}), oresCollected: result.oresCollected, laneId: result.laneId || data.action.params?.laneId || "1", route: result.route || null, updatedAt: Date.now() };
        this.resumeExact = true;
      } else if (data.action?.type === "fishbone_mine" && ["danger", "no_tool", "inventory_full"].includes(result.stopReason)) {
        this.continuingTask = null;this.continuationProgress = null;this.resumeExact = false;
      } else if (data.action?.type === "fishbone_mine" && result.targetReached === true) {
        this.continuationProgress = null;
        const nextActions=(data.task?.actions||[]).slice((data.actionIndex||0)+1);
        this.continuingTask=nextActions.length?{...data.task,actions:nextActions}:null;
        this.resumeExact=nextActions.length>0;
      } else if (!data.taskLast && data.task) {
        const nextActions=(data.task.actions||[]).slice((data.actionIndex||0)+1);this.continuingTask={...data.task,actions:nextActions};this.resumeExact=nextActions.length>0;
      } else if (data.taskLast) {
        this.lastFailure=null;
      }
      this.persist();
    });
    this.events.on("task-complete", ({ taskId }) => { if (this.continuingTask?.id === taskId) { this.continuingTask = null;this.continuationProgress = null;this.resumeExact=false;this.persist(); } });
  }
  async load() {
    if (!this.filePath) return this;
    try { const data = JSON.parse(await readFile(this.filePath, "utf8"));this.currentPlan=data.currentPlan||null;this.continuingTask=data.continuingTask||null;this.continuationProgress=data.continuationProgress||null;this.lastFailure=data.lastFailure||null;this.workareaRetryAt=Number(data.workareaRetryAt)||0;this.workareaLastCompleted=Number.isFinite(data.workareaLastCompleted)?data.workareaLastCompleted:null;this.workareaFailureKey=data.workareaFailureKey||null;this.workareaFailureCount=Number(data.workareaFailureCount)||0;this.workareaBlocked=data.workareaBlocked||null;this.warningRetryAt=Number(data.warningRetryAt)||0;this.warningFailureKey=data.warningFailureKey||null;this.warningFailureCount=Number(data.warningFailureCount)||0;this.warningBlocked=data.warningBlocked||null;if(this.continuingTask?.actions?.[0]?.type==="build_workarea"&&this.workareaLastCompleted!==null&&this.workareaRetryAt<Date.now())this.workareaFailureCount=Math.max(1,this.workareaFailureCount);this.resumeExact=Boolean(data.resumeExact)&&!this.lastFailure; }
    catch(error){if(error.code!=="ENOENT")throw error;}
    return this;
  }
  persist() {
    if(!this.filePath)return Promise.resolve();
    const payload=JSON.stringify({version:1,currentPlan:this.currentPlan,continuingTask:this.continuingTask,continuationProgress:this.continuationProgress,lastFailure:this.lastFailure,resumeExact:this.resumeExact,workareaRetryAt:this.workareaRetryAt,workareaLastCompleted:this.workareaLastCompleted,workareaFailureKey:this.workareaFailureKey,workareaFailureCount:this.workareaFailureCount,workareaBlocked:this.workareaBlocked,warningRetryAt:this.warningRetryAt,warningFailureKey:this.warningFailureKey,warningFailureCount:this.warningFailureCount,warningBlocked:this.warningBlocked,updatedAt:Date.now()});
    this.saving=this.saving.catch(()=>{}).then(async()=>{await mkdir(path.dirname(this.filePath),{recursive:true});const temp=`${this.filePath}.tmp`;await writeFile(temp,payload,"utf8");await rename(temp,this.filePath);});
    return this.saving;
  }
  addDebugHint(text) { const hint = { text: String(text || "").trim(), at: Date.now() };if (!hint.text) return null;this.workareaBlocked=null;this.workareaFailureCount=0;this.workareaFailureKey=null;this.workareaRetryAt=0;this.warningBlocked=null;this.warningFailureCount=0;this.warningFailureKey=null;this.warningRetryAt=0;this.debugHints.push(hint);this.debugHints = this.debugHints.slice(-30);this.events.emit("debug-hint", hint);return hint; }
  replanAfterFailure(failure) {
    const action = failure?.action || {};
    const target = action.params?.target || action.params?.pos;
    const navigationFailure = ["path_not_found", "navigation_failed", "unreachable", "no_path", "stalled"].includes(failure?.error?.code);
    const tasks = navigationFailure && Array.isArray(target) && target.length === 3
      ? [{ id: "failure-" + randomUUID(), title: "失败后调整路线", goal: "只对明确失败的目标尝试一次安全寻路恢复", failureRecovery: true, actions: [{ type: "navigation_recover", params: { target } }] }]
      : [];
    const plan = { planId: "quick-" + randomUUID(), rationale: "动作失败（" + (failure?.error?.code || "unknown") + "），停止依赖任务并立即重新分发", priorities: ["失败后重新规划"], tasks, createdAt: Date.now(), noThink: true };
    if (tasks.length) this.events.emit("action-recovery-plan", { plan, context: { layer: "distribution", noThink: true, failedAction: action, error: failure?.error } });
    return plan;
  }
  async replan(snapshot, { strategicPlan, execution, nativeState, queuedTasks = [], nextTask = false, repair = false } = {}) {
    if (this.running) return this.running;
    const hasAuthoritativeContinuation = Boolean(this.continuingTask && this.resumeExact);
    if (this.warningRetryAt > Date.now() && !hasAuthoritativeContinuation && !repair) return { planId: `hold-warning-${this.warningFailureCount}`, rationale: "等待下一次修复分发", tasks: [], createdAt: Date.now(), noThink: true };
    if (this.warningBlocked) {
      const currentEnvironment = warningEnvironmentKey(snapshot);
      if (this.warningBlocked.environmentKey && currentEnvironment !== this.warningBlocked.environmentKey) {
        this.warningBlocked = null; this.warningFailureCount = 0; this.warningFailureKey = null; this.warningRetryAt = 0;
      } else if (!hasAuthoritativeContinuation) {
        this.warningBlocked.environmentKey ||= currentEnvironment;
      }
    }
    if (["build_workarea", "build_base"].includes(this.continuingTask?.actions?.[0]?.type) && this.workareaRetryAt > Date.now()) {
      return { planId: `hold-${this.continuingTask.id}`, rationale: "工作区施工暂时无新进展，等待环境变化后继续原位置", tasks: [], createdAt: Date.now(), noThink: true };
    }
    if (this.workareaBlocked?.checked) return { planId: `hold-workarea-${this.workareaBlocked.completed}`, rationale: "相同工作区方案已失败，已停止自动重复；等待新策略或人工提示", tasks: [], createdAt: Date.now(), noThink: true };
    if (this.modelBlocked && (this.modelBlocked.code === "llm_budget_exhausted" || Date.now() < this.modelBlocked.retryAt)) return { tasks: [], rationale: this.modelBlocked.message, budgetBlocked: true };
    this.lastRunAt = Date.now();
    this.running = (async () => {
      const healingDeferred = !nextTask && canContinueWithoutHealing(snapshot?.status, nativeState);
      const resumeAfterProtection = healingDeferred && this.lastFailure?.error?.code === "survival_priority"
        && this.continuingTask?.actions?.[0]?.type !== "navigation_recover";
      if (snapshot?.status?.alive !== false && this.continuingTask && !nextTask
          && ((this.resumeExact && !this.lastFailure) || resumeAfterProtection)) {
        const task = this.continuingTask;
        if (resumeAfterProtection) this.lastFailure = null;
        const plan = { planId: `resume-${task.id}-${randomUUID()}`, rationale: "继续上次中断的原任务，并从已记录进度接续", priorities: ["保持原任务"], tasks: [{ ...task, actions: task.actions }], createdAt: Date.now() };
        this.currentPlan=plan;this.resumeExact=false;this.events.emit("distribution-output",{raw:plan,plan,context:{layer:"distribution",taskContinuity:{mode:"continue_incomplete",activeTask:task},continuationProgress:this.continuationProgress},resumed:true});await this.persist();return plan;
      }
      if (healingDeferred && snapshot.status.on_ground && !this.resumeExact
          && !(snapshot.inventory?.items || []).some(item => /_(log|stem|planks|pickaxe)$/.test(item.name))
          && Object.entries(snapshot.blocks?.blocks || {}).some(([name, block]) => /_log$/.test(name) && block.dist <= 12)
          && !(this.lastFailure?.action?.type === "chop_tree" && this.lastFailure.error?.code !== "survival_priority")) {
        const plan = normalizeNativePlan({
          rationale: "回血条件不足，按开局流程就近采木",
          tasks: [{ title: "采集附近的原木", actions: [{ type: "chop_tree", params: { targetCount: 8, radius: 12, exploreSteps: 0 } }] }]
        });
        this.currentPlan = plan;
        this.events.emit("distribution-output", { raw: plan, plan, context: { layer: "distribution" } });
        await this.persist();
        return plan;
      }
      const failedTask = this.lastFailure?.at && Date.now() - this.lastFailure.at < 120000 ? this.lastFailure.task : null;
      // A newly started continuation is authoritative even when a previous
      // warning is still retained for reflection. Otherwise the stale warning
      // changes the context to repair_and_continue and the model may emit an
      // empty plan while the executor is idle, leaving the queue asleep.
      const continuing = Boolean(this.continuingTask && this.resumeExact);
      const activeTask = execution?.activeTask || (continuing ? this.continuingTask : failedTask || this.continuingTask);
      const continuityMode = nextTask ? "plan_next" : continuing ? "continue_incomplete" : failedTask ? "repair_and_continue" : this.continuingTask ? "continue_incomplete" : "reassess";
      const measuredAt = Date.now(); let measuredSuccess = false, measuredError = null, inputChars = 0;
      try {
        const inventoryBrief = this.inventoryBrief ? await this.inventoryBrief(snapshot?.inventory) : null;
        const context = buildDistributionContext({ snapshot, strategicPlan, execution, nativeState, queuedTasks, scriptCatalog: SCRIPT_CATALOG, activeTask, failedTask, continuityMode, continuationProgress: this.continuationProgress, debugHints: this.debugHints, memory: this.memory.snapshot(), memoryArchive: this.memoryArchive.contextSnapshot(), lastFailure: this.lastFailure, inventoryBrief, progressLedger: this.progressLedger });
        inputChars = JSON.stringify({ context, activePlan: compactDistributionPlan(this.currentPlan) }).length;
        this.events.emit("distribution-input", { context, activePlan: compactDistributionPlan(this.currentPlan) });
        if (typeof this.provider?.createAutomationPlan !== "function") throw Object.assign(new Error("Distribution 模型未接入，无法分发自动化任务；请检查模型配置"), { code: "llm_not_configured" });
        const raw = await this.provider.createAutomationPlan({ context, activePlan: compactDistributionPlan(this.currentPlan), noThink: repair || Boolean(this.lastFailure) });
        const plan = normalizeNativePlan(raw);
        if (this.lastFailure?.action?.type === "staircase_up" && this.lastFailure?.error?.code === "missing_item") {
          const params = this.lastFailure.action.params || {};
          const direction = ["x", "-x", "z", "-z"].includes(params.direction) ? params.direction : "x";
          for (const task of plan.tasks || []) {
            task.actions = task.actions.filter(action => !(action.type === "mine_vein" && (action.params?.types || []).some(type => ["stone", "deepslate", "andesite", "cobblestone", "cobbled_deepslate"].includes(String(type).replace(/^minecraft:/, "")))));
          }
          plan.tasks = (plan.tasks || []).filter(task => task.actions.length);
          const hasAscent = plan.tasks.some(task => task.actions.some(action => action.type === "staircase_up"));
          if (!hasAscent) {
            plan.tasks.unshift({ id: `natural-ascent-${randomUUID()}`, title: "沿天然台阶上行", goal: "从当前地形选择有实体支撑的方向向上开挖，不采石料垫脚", actions: [{ type: "staircase_up", params: { direction, steps: 2 } }] });
          }
          plan.rationale = "向上优先沿有支撑的地形开挖，不为垫脚任务另采石料";
        }
        const forbidden = new Set(context.control.forbiddenActions);
        const stalledWarning = this.warningBlocked;
        if (stalledWarning) {
          const repeatsFailure = action => JSON.stringify([action.type, action.params || {}, stalledWarning.code]) === stalledWarning.key;
          const firstBlocked = plan.tasks.findIndex(task => task.actions.some(repeatsFailure));
          if (firstBlocked >= 0) {
            plan.tasks = plan.tasks.slice(0, firstBlocked);
            plan.rationale += " 已拦截相同失败动作及依赖它的后续步骤。";
            this.warningRetryAt = Date.now() + 15000;
          }
        }
        if (forbidden.size) {
          const before = plan.tasks.length;
          plan.tasks = plan.tasks.map(task => ({ ...task, actions: task.actions.filter(action => !forbidden.has(action.type)) })).filter(task => task.actions.length);
          if (before !== plan.tasks.length) {
            plan.rationale = `${plan.rationale} 当前采矿任务不另开基地，已由本地调度器过滤。`;
            this.debugHints.push({ text: "当前采矿阶段继续原矿道，普通石料可清理，矿物应存入补给箱；装备资源齐备后允许进入扩建阶段。", at: Date.now() });
          }
        }
        if (this.workareaBlocked) {
          const repeated = plan.tasks.some(task => task.actions.some(action => JSON.stringify(action.params || {}) === this.workareaBlocked.key && action.type === "build_workarea"));
          if (repeated) {
            const hold = { planId: `hold-workarea-${this.workareaBlocked.completed}`, rationale: "同一工作区已连续失败，拒绝再次重复该参数", tasks: [], createdAt: Date.now(), noThink: true };
            this.workareaBlocked.checked = true; this.currentPlan = hold; this.events.emit("distribution-output", { raw: hold, plan: hold, context, blocked: true }); await this.persist(); measuredSuccess = true; return hold;
          }
          this.workareaBlocked = null; this.workareaFailureCount = 0; this.workareaFailureKey = null; this.lastFailure = null;
        }
        this.modelBlocked = null;this.currentPlan = plan;this.events.emit("distribution-output", { raw, plan, context });await this.persist();measuredSuccess=true;return plan;
      } catch (error) { if (/^llm_budget_/.test(error.code || "")) this.modelBlocked={code:error.code,message:error.message,retryAt:Date.now()+30000};measuredError=error;this.events.emit("distribution-error", { error, context: { layer: "distribution", taskContinuity: { mode: continuityMode, activeTask: compactDistributionPlan({ tasks: activeTask ? [activeTask] : [] })?.tasks[0] || null } } });throw error; }
      finally { this.events.emit("distribution-measured", { durationMs: Date.now() - measuredAt, inputChars, success: measuredSuccess, errorCode: measuredError?.code }); }
    })().finally(() => { this.running = null; });
    return this.running;
  }
}
