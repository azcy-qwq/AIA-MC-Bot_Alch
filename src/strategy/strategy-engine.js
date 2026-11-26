import { EventBus } from "../core/events.js";
import { summarizeEnvironment } from "../core/environment-summary.js";
import { randomUUID } from "node:crypto";
import { buildEarlyGameCraftingSnapshot } from "../action/crafting-tree.js";

const ACTION_TYPES = new Set(["move_to", "dig", "mine_continuous", "dig_many", "dig_nearest", "place", "interact", "use_item", "attack", "shoot", "craft", "window_view", "window_act", "equip", "posture", "dismount", "drop", "navigation_recover", "bridge_to", "ladder_climb", "staircase_down", "staircase_up", "route_navigate", "flatten_area", "chop_tree", "mine_vein", "fishbone_mine"]);

function normalizePlan(input) {
  const tasks = Array.isArray(input?.tasks) ? input.tasks : [];
  return {
    planId: input.planId || `plan-${Date.now()}-${randomUUID()}`,
    rationale: String(input?.rationale || ""),
    priorities: Array.isArray(input?.priorities) ? input.priorities.map(String) : [],
    tasks: tasks.slice(0, 1).map((task, taskIndex) => ({
      id: String(task.id || `task-${taskIndex}`),
      title: String(task.title || task.goal || `Task ${taskIndex + 1}`),
      goal: String(task.goal || ""),
      maxAttempts: Math.min(2, Math.max(1, Math.floor(Number(task.maxAttempts) || 1))),
      actions: (Array.isArray(task.actions) ? task.actions : []).filter(action => ACTION_TYPES.has(action?.type)).map(action => ({ type: action.type, params: action.params || {} }))
    })),
    delegation: Array.isArray(input?.delegation) ? input.delegation.slice(0, 3).map(item => ({ role: String(item.role || "generalist"), objective: String(item.objective || ""), priority: Number(item.priority) || 0 })) : [],
    createdAt: Date.now()
  };
}

function planningFingerprint(snapshot) {
  const context = summarizeEnvironment(snapshot, "strategy");
  return JSON.stringify({
    dimension: context.status?.dimension,
    // Position and the local spatial origin are gameplay changes even when
    // risk flags stay identical. Omitting them lets a stale Distribution
    // task survive several partial moves and repeat an obsolete route.
    position: context.status?.position?.map(value => Number.isFinite(Number(value)) ? Math.floor(Number(value)) : value),
    spatialOrigin: context.spatial?.origin?.map(value => Math.floor(Number(value))),
    spatialKnown: context.spatial?.knownCells,
    missionMissing: context.mission?.missing || [],
    risks: [...(context.risks?.risks || [])].sort(),
    alive: context.status?.hazards?.alive,
    ready: context.status?.hazards?.ready
  });
}

function taskWords(task = {}) {
  return new Set(String(`${task.title || ""} ${task.goal || ""}`).toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(word => word.length > 1));
}

function sameTask(previous = {}, next = {}) {
  if (!previous || !next) return false;
  if (previous.id && next.id && previous.id === next.id) return true;
  const a = taskWords(previous);
  const b = taskWords(next);
  if (!a.size || !b.size) return false;
  const overlap = [...a].filter(word => b.has(word)).length;
  return overlap / Math.min(a.size, b.size) >= 0.5;
}

function taskActionsChanged(previous = {}, next = {}) {
  return JSON.stringify(previous.actions || []) !== JSON.stringify(next.actions || []);
}

export class StrategyEngine {
  constructor({ provider, eventBus = new EventBus(), minReplanMs = 30000, routeMemory = null, memory = null, memoryArchive = null } = {}) {
    this.provider = provider;
    this.events = eventBus;
    this.minReplanMs = minReplanMs;
    this.routeMemory = routeMemory;
    this.memory = memory;
    this.memoryArchive = memoryArchive;
    this.currentPlan = null;
    this.lastRunAt = 0;
    this.running = null;
    this.lastPlanningFingerprint = null;
    this.lastHintAt = 0;
    this.debugHints = [];
    this.lastActionFailure = null;
    this.events.on("action-error", ({ action, error }) => {
      this.lastActionFailure = { action: action?.type, params: action?.params, code: error?.code || null, message: error?.message || String(error), at: Date.now() };
    });
    this.events.on("action-end", () => { this.lastActionFailure = null; });
    this.events.on("task-complete", ({ taskId, planId } = {}) => {
      if (this.currentPlan?.tasks?.[0]?.id === taskId && (!planId || this.currentPlan.planId === planId || this.currentPlan.continuesTaskId === taskId)) {
        this.currentPlan = null;
        this.lastPlanningFingerprint = null;
      }
    });
    this.events.on("task-error", ({ taskId, final } = {}) => {
      if (final && this.currentPlan?.tasks?.[0]?.id === taskId) {
        this.currentPlan = null;
        this.lastPlanningFingerprint = null;
      }
    });
  }

  addDebugHint(text) {
    const hint = String(text || "").trim();
    if (!hint) return null;
    this.debugHints.push({ text: hint, at: Date.now() });
    if (this.debugHints.length > 30) this.debugHints.splice(0, this.debugHints.length - 30);
    this.events.emit("debug-hint", this.debugHints.at(-1));
    return this.debugHints.at(-1);
  }

  setDebugHints(hints = []) { this.debugHints = hints.slice(-30); }

  async replan(snapshot, { force = false, execution = null, strategicPlan = null, nextTask: planNext = false } = {}) {
    if (!this.provider) throw new Error("Strategy provider is required");
    if (this.running) return this.running;
    if (!force && Date.now() - this.lastRunAt < this.minReplanMs) return this.currentPlan;
    this.lastRunAt = Date.now();
    this.running = (async () => {
      const context = summarizeEnvironment(snapshot, "strategy");
      context.layer = "distribution";
      context.strategicPlan = strategicPlan;
      context.craftingTree = buildEarlyGameCraftingSnapshot(snapshot?.inventory);
      if (this.lastActionFailure) context.recentActionFailure = this.lastActionFailure;
      context.navigationRecoveryAllowed = true;
      if (this.debugHints.length) context.debugHints = this.debugHints;
      if (this.routeMemory) context.routeMemory = this.routeMemory.snapshot();
      if (this.memory) context.memory = this.memory.snapshot();
      if (this.memoryArchive) context.memoryArchive = this.memoryArchive.snapshot();
      const fingerprint = planningFingerprint(snapshot);
      const previousPlan = this.currentPlan;
      const hintAt = this.debugHints.at(-1)?.at || 0;
      const unchanged = Boolean(!planNext && previousPlan && !this.lastActionFailure && this.lastPlanningFingerprint === fingerprint && this.lastHintAt === hintAt);
      context.taskContinuity = {
        mode: planNext ? "plan_next" : unchanged ? "continue_and_improve" : "reassess",
        activeTask: previousPlan?.tasks?.[0] || null,
        execution,
        note: planNext ? "当前任务预计在4秒内结束，只准备完成后的下一任务，不重放当前任务；新任务须等前一任务结束才执行，实际前置条件仍由执行器检查。" : "任务未完成且没有新危险、失败或人工指令时，保持原目标；移动、挖到资源和普通实体移动属于任务进度。只优化未执行动作，不重复已完成或正在执行的动作。"
      };
      this.events.emit("distribution-input", { context, activePlan: this.currentPlan });
      try {
        const raw = await this.provider.createPlan({ snapshot, context, activePlan: this.currentPlan });
        let plan = normalizePlan(raw);
        const previousTask = previousPlan?.tasks?.[0];
        const nextTask = plan.tasks?.[0];
        // A task can finish while the model is thinking; do not resurrect it from stale input.
        if (previousTask && this.currentPlan !== previousPlan && sameTask(previousTask, nextTask) && (!planNext || !taskActionsChanged(previousTask, nextTask))) {
          this.events.emit("distribution-output", { raw, plan: { ...plan, tasks: [] }, context, discarded: "task_already_finished" });
          return null;
        }
        let continuity = false;
        if (unchanged && previousTask && !sameTask(previousTask, nextTask)) {
          continuity = true;
          plan = {
            ...previousPlan,
            rationale: `继续未完成任务：${previousTask.title}。环境没有关键变化，暂不切换目标。`
          };
        } else if (unchanged && previousTask && nextTask) {
          continuity = true;
          plan = {
            ...plan,
            planId: taskActionsChanged(previousTask, nextTask) ? plan.planId : previousPlan.planId,
            createdAt: previousPlan.createdAt,
            continuesTaskId: previousTask.id,
            tasks: [{ ...nextTask, id: previousTask.id, title: previousTask.title, goal: previousTask.goal }]
          };
        }
        this.currentPlan = plan;
        this.lastPlanningFingerprint = fingerprint;
        this.lastHintAt = hintAt;
        this.events.emit("distribution-output", { raw, plan, context, continuity });
        this.events.emit("plan", plan);
        return plan;
      } catch (error) {
        this.events.emit("distribution-error", { error, context });
        throw error;
      }
    })().finally(() => { this.running = null; });
    return this.running;
  }
}

export { normalizePlan };
