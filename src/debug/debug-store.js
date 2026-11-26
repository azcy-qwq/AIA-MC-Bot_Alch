import { estimateEarlySurvivalProgress } from "../strategy/early-survival-flow.js";
const MAX_ITEMS = 300;
const MAX_TIMELINE = 500;
const emptyUsage = () => ({ prompt: 0, completion: 0, total: 0, requests: 0, unreportedRequests: 0, cachedPrompt: 0, uncachedPrompt: 0, cacheEligiblePrompt: 0, cacheReportedRequests: 0 });
function addUsage(target, usage) {
  target.requests++;
  if (!usage) { target.unreportedRequests++; return; }
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0), completion = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  target.prompt += prompt; target.completion += completion; target.total += Number(usage.total_tokens) || prompt + completion;
  const cached = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens;
  if (cached !== undefined && Number.isFinite(Number(cached))) {
    target.cachedPrompt += Math.max(0, Math.min(prompt, Number(cached)));
    target.uncachedPrompt += Number(usage.prompt_cache_miss_tokens ?? Math.max(0, prompt - Number(cached)));
    target.cacheEligiblePrompt += prompt; target.cacheReportedRequests++;
  }
}

function cleanError(error) {
  return { name: error?.name || "Error", message: error?.message || String(error), code: error?.code || null, details: error?.details || null };
}

export class DebugStore {
  constructor({ worldModel, eventBus, memoryArchive = null, executor = null, runner = null, progressLedger = null }) {
    this.worldModel = worldModel;
    this.progressLedger = progressLedger;
    this.eventBus = eventBus;
    this.memoryArchive = memoryArchive;
    this.executor = executor;
    this.runner = runner;
    this.state = {
      startedAt: Date.now(),
      status: "starting",
      environment: null,
      lastStrategyInput: null,
      lastStrategy: null,
      lastStrategicInput: null,
      lastStrategic: null,
      lastDistributionInput: null,
      lastDistribution: null,
      plans: [],
      execution: null,
      autonomousWork: null,
      toolCalls: [],
      llmCalls: [],
      tokenUsage: { ...emptyUsage(), byProvider: {} },
      layers: {
        strategic: { status: "idle", label: "等待长期规划", startedAt: null, updatedAt: Date.now(), durationMs: 0, detail: "" },
        distribution: { status: "idle", label: "等待任务分发", startedAt: null, updatedAt: Date.now(), durationMs: 0, detail: "" },
        strategy: { status: "idle", label: "等待决策", startedAt: null, updatedAt: Date.now(), durationMs: 0, detail: "" },
        action: { status: "idle", label: "等待执行", startedAt: null, updatedAt: Date.now(), durationMs: 0, detail: "" },
        tac: { status: "monitoring", label: "监控中", startedAt: null, updatedAt: Date.now(), durationMs: 0, detail: "" },
        reflection: { status: "idle", label: "等待总结", startedAt: null, updatedAt: Date.now(), durationMs: 0, detail: "" },
        memory: { status: "idle", label: "等待归档", startedAt: null, updatedAt: Date.now(), durationMs: 0, detail: "" }
      },
      timeline: [],
      debugHints: [],
      reflection: { document: "尚未生成运行总结。", lessons: [], nextHints: [], updatedAt: 0 },
      memoryArchive: { entries: [], latestSummary: null, updatedAt: 0 },
      agentOutputs: [],
      tacEvents: [],
      runtimeEvents: []
    };
    this.unsubscribers = [];
    this.bind("started", data => this.push("runtimeEvents", { type: "started", at: Date.now(), data }));
    this.bind("stopped", () => this.push("runtimeEvents", { type: "stopped", at: Date.now() }));
    this.bind("respawn-waiting", data => { this.state.status = "respawning"; this.push("runtimeEvents", { type: "respawn-waiting", at: Date.now(), data }); });
    this.bind("respawned", data => {
      this.state.status = "online";
      this.state.layers.tac = { ...this.state.layers.tac, status: "monitoring", label: "监控中", detail: "已重生，恢复安全监控", startedAt: null, updatedAt: Date.now(), durationMs: 0 };
      this.push("runtimeEvents", { type: "respawned", at: Date.now(), data });
      this.timeline("tac", "success", "角色已重生", "Tac 恢复监控");
    });
    this.bind("tac-reset", data => {
      this.state.layers.tac = { ...this.state.layers.tac, status: "monitoring", label: "监控中", detail: data?.reason === "respawned" ? "已重置战斗冷却" : "监控中", updatedAt: Date.now() };
    });
    this.bind("runtime-warning", data => this.push("runtimeEvents", { type: "runtime-warning", at: Date.now(), ...data }));
    this.bind("strategy-input", data => {
      this.state.lastStrategyInput = data;
      this.setLayer("strategy", { status: "running", label: "分析环境", startedAt: Date.now(), detail: "正在生成计划" });
      this.timeline("strategy", "start", "Strategy 开始分析", data.context?.risks?.risks?.join("、") || "读取环境摘要");
    });
    this.bind("strategic-input", data => {
      this.state.lastStrategicInput = { ...data, at: Date.now() };
      this.setLayer("strategic", { status: "running", label: "规划长期路线", startedAt: Date.now(), detail: "分析阶段目标、路线和长期风险" });
      this.timeline("strategic", "start", "Strategic 开始规划", data.context?.layer || "长期战略");
    });
    this.bind("strategic-output", data => {
      this.state.lastStrategic = { ...data, at: Date.now() };
      this.setLayer("strategic", { status: "success", label: "战略已更新", detail: data.plan?.mission || "长期目标已更新" });
      this.timeline("strategic", "success", "Strategic 输出长期计划", data.plan?.mission || "阶段目标已更新");
    });
    this.bind("strategic-error", data => {
      this.push("runtimeEvents", { type: "strategic-error", at: Date.now(), error: cleanError(data.error) });
      this.setLayer("strategic", { status: "error", label: "战略规划失败", detail: data.error?.message || "未知错误" });
      this.timeline("strategic", "error", "Strategic 出错", data.error?.message || "未知错误");
    });
    this.bind("distribution-input", data => {
      this.state.lastDistributionInput = { ...data, at: Date.now() };
      const task = data.context?.taskContinuity?.activeTask || data.activePlan?.tasks?.[0];
      const detail = task?.title ? `正在评估短期任务：${task.title}` : "读取当前环境与脚本进度，生成短期任务；尚未返回分发结果";
      this.setLayer("distribution", { status: "running", label: "分发短期任务", startedAt: Date.now(), detail });
      this.timeline("distribution", "start", "Distribution 开始分发", detail);
    });
    this.bind("distribution-output", data => {
      if (data.discarded) { this.timeline("distribution", "discarded", "Distribution 丢弃过期结果", data.discarded); return; }
      this.state.lastDistribution = { ...data, at: Date.now() };
      this.push("plans", { at: Date.now(), ...data });
      this.setLayer("distribution", { status: "success", label: "方案已生成", detail: data.plan?.tasks?.[0]?.title || "无任务" });
      this.timeline("distribution", "success", "Distribution 输出任务", data.plan?.tasks?.[0]?.title || "无任务");
    });
    this.bind("distribution-error", data => {
      this.push("runtimeEvents", { type: "distribution-error", at: Date.now(), error: cleanError(data.error) });
      this.setLayer("distribution", { status: "error", label: "分发失败", detail: data.error?.message || "未知错误" });
      this.timeline("distribution", "error", "Distribution 出错", data.error?.message || "未知错误");
    });
    this.bind("distribution-blocked", data => {
      this.setLayer("distribution", { status: "error", label: "等待 API 故障处理", detail: data.reason || "第三方挖掘接口兼容故障；当前任务已保留" });
      this.timeline("distribution", "blocked", "停止重复调用模型", data.reason);
    });
    this.bind("distribution-retry-scheduled", data => {
      this.setLayer("distribution", { status: "idle", label: `${Math.ceil(data.delayMs / 1000)} 秒后重试`, detail: data.error?.message || "准备重新分发任务" });
      this.timeline("distribution", "retry", `Distribution 将在 ${Math.ceil(data.delayMs / 1000)} 秒后重试`, data.error?.message || "自动恢复");
    });
    this.bind("distribution-idle-recheck", data => {
      this.setLayer("distribution", { status: "idle", label: `${Math.ceil(data.delayMs / 1000)} 秒后重新检查`, detail: "当前没有可执行任务，避免长时间无唤醒" });
      this.timeline("distribution", "retry", `Distribution 将在 ${Math.ceil(data.delayMs / 1000)} 秒后检查空闲状态`, "防止空计划后执行器永久停滞");
    });
    this.bind("strategy-output", data => {
      this.state.lastStrategy = data;
      this.push("plans", { at: Date.now(), ...data });
      this.setLayer("strategy", { status: "success", label: "计划已输出", detail: data.plan?.tasks?.[0]?.title || "无任务" });
      this.timeline("strategy", "success", data.continuity ? "Strategy 继承并改进原任务" : "Strategy 输出计划", data.plan?.tasks?.[0]?.title || "无任务");
    });
    this.bind("strategy-error", data => {
      this.push("runtimeEvents", { type: "strategy-error", at: Date.now(), error: cleanError(data.error) });
      this.setLayer("strategy", { status: "error", label: "策略错误", detail: data.error?.message || "未知错误" });
      this.timeline("strategy", "error", "Strategy 出错", data.error?.message || "未知错误");
    });
    this.bind("plan-queued", data => this.timeline("action", "queued", "Action 计划排队", data.task || data.planId || "等待当前动作完成"));
    this.bind("distribution-prefetch", data => this.timeline("distribution", "prefetch", "按耗时预测提前生成下一任务", `工作剩余约 ${Math.round(data.remainingMs / 1000)} 秒，分发提前量 ${Math.round(data.leadMs / 1000)} 秒`));
    this.bind("distribution-plan-enqueued", () => this.setLayer("distribution", { status: "success", label: "任务已入队" }));
    this.bind("distribution-plan-discarded", data => {
      if (data.planIds?.includes(this.state.lastDistribution?.plan?.planId)) {
        this.state.lastDistribution.discarded = data.reason;
        this.setLayer("distribution", { status: "idle", label: "方案已作废", detail: data.reason });
      }
      this.timeline("distribution", "discarded", "方案已作废", data.reason);
    });
    this.bind("distribution-plan-ready", data => {
      this.setLayer("distribution", { status: "idle", label: "下一计划已准备，等待当前工作结束", detail: data.task });
      this.timeline("distribution", "ready", "预生成计划已缓存，尚未入队", data.task);
    });
    this.bind("distribution-plan-released", data => this.timeline("distribution", "queued", "当前工作与队列已结束，分发预生成计划", data.task));
    this.bind("distribution-plan-enqueued", data => this.timeline("distribution", "queued", "Distribution 计划已进入 Action 队列", `${data.taskCount} 个任务 · 队列 ${data.queueLength}${data.joinedInFlight ? " · 接续并发请求" : ""}`));
    this.bind("distribution-plan-enqueue-skipped", data => this.timeline("distribution", "warning", "Distribution 计划未重复入队", data.reason || data.planId));
    this.bind("distribution-plan-empty", data => this.timeline("distribution", "idle", "Distribution 暂无可执行任务", data.reason));
    this.bind("distribution-plan-duplicate-ignored", data => this.timeline("distribution", "warning", "忽略重复的 Distribution 计划", data.planId));
    this.bind("plan-deferred", data => this.timeline("distribution", "deferred", "Distribution 结果延后到鱼骨脚本结束", data.reason || data.planId));
    this.bind("task-start", data => { this.state.execution = { ...data, status: "running", startedAt: Date.now() }; });
    for (const type of ["task-complete", "task-error", "task-warning"]) this.bind(type, data => {
      if (type !== "task-complete" && !data.final) return;
      if (this.state.execution?.taskId === data.taskId) this.state.execution = { ...this.state.execution, status: type === "task-complete" ? "complete" : type === "task-warning" ? "warning" : "error", endedAt: Date.now() };
    });
    this.bind("action-start", data => {
      this.push("toolCalls", { type: "start", at: Date.now(), ...data });
      this.setLayer("action", { status: "running", label: "执行中", startedAt: data.startedAt || Date.now(), detail: `${data.source || "Action"} · ${data.action?.type || "未知动作"}` });
      this.timeline("action", "start", "Action 开始执行", `${data.source || "Action"} · ${data.action?.type || "未知动作"}`);
    });
    this.bind("action-progress", data => {
      if (data.source === "tac" && data.progress?.phase === "protection_hold" && data.progress.kind === "low_health" && Number.isFinite(data.progress.health)) {
        const { health, food, message } = data.progress;
        this.setLayer("tac", { status: "alert", label: "低血保护中", detail: `${message} · 生命 ${health.toFixed(1)} · 饥饿 ${food}` });
      }
      if (["chop_tree", "mine_vein", "fishbone_mine"].includes(data.action?.type)) {
        this.state.autonomousWork = data.progress;
        const p = data.progress;
        const work = data.action.type === "fishbone_mine"
          ? `矿道 ${p.laneId || data.action.params?.laneId || "?"} · ${p.origin?.join(",") || p.hub?.join(",") || ""} → ${p.end?.join(",") || ""} · 已采 ${p.oresCollected ?? 0}`
          : `入包 ${p.currentCount}/${p.targetCount} · ${p.mined || 0} 块${p.nearEnd ? " · 准备下一任务" : ""}`;
        this.setLayer("action", { status: "running", label: "脚本持续作业", detail: `${data.action.type} · ${p.phase} · ${work}` });
      }
      this.push("toolCalls", { type: "progress", at: Date.now(), ...data });
    });
    this.bind("native-api", data => {
      this.push("toolCalls", { type: data.ok ? "success" : "error", at: Date.now(), source: data.source || "C++ 自动化", planId: data.planId, taskId: data.taskId, parentAction: data.parentAction, action: { type: data.method, params: data.params }, durationMs: data.durationMs, error: data.error });
    });
    this.bind("action-normalized", data => this.push("toolCalls", { type: "normalized", at: Date.now(), ...data }));
    this.bind("action-preflight", data => {
      this.push("toolCalls", { type: "preflight", at: Date.now(), ...data });
      const detail = data.missing?.length
        ? data.missing.map(item => `${item.item} ${item.available}/${item.need}`).join("、")
        : `${data.item || "物品"} ×${data.requested || data.required || 1}`;
      this.timeline("action", data.ok ? "preflight" : "error", data.ok ? "Action 材料检查通过" : "Action 材料检查拒绝", detail);
    });
    this.bind("action-end", data => {
      this.state.autonomousWork = null;
      this.push("toolCalls", { type: "success", at: Date.now(), ...data });
      const timing = [data.durationMs ? `执行 ${data.durationMs}ms` : "", data.queueWaitMs ? `排队 ${data.queueWaitMs}ms` : ""].filter(Boolean).join(" · ");
      this.setLayer("action", { status: "success", label: "执行完成", detail: `${data.action?.type || "动作"}${timing ? ` · ${timing}` : ""}` });
      this.timeline("action", "success", "Action 执行完成", `${data.action?.type || "动作"}${timing ? ` · ${timing}` : ""}`);
    });
    this.bind("action-error", data => {
      this.state.autonomousWork = null;
      this.push("toolCalls", { type: "error", at: Date.now(), ...data, error: cleanError(data.error) });
      this.setLayer("action", { status: "error", label: "执行失败", detail: data.error?.message || data.error?.code || "未知错误" });
      this.timeline("action", "error", "Action 执行失败", data.error?.message || data.error?.code || "未知错误");
    });
    this.bind("action-warning", data => {
      this.state.autonomousWork = null;
      this.push("toolCalls", { type: "warning", at: Date.now(), ...data });
      this.setLayer("action", { status: "alert", label: "脚本请求重新规划", detail: data.warning?.message || data.warning?.code || "环境条件暂不满足" });
      this.timeline("action", "alert", "Action 提示可恢复条件", data.warning?.message || data.warning?.code || "重新选择工作方案");
    });
    this.bind("action-retry-scheduled", data => {
      const action = data.action?.type || "动作";
      this.timeline("action", "retry", `${action} 网络失败后续跑原任务`, data.reason?.message || `第 ${data.attempt} 次重试`);
    });
    this.bind("emergency", data => {
      this.push("tacEvents", { type: "emergency", at: Date.now(), ...data });
      this.setLayer("tac", { status: "alert", label: "紧急处置", detail: data.kind || "安全事件" });
      this.timeline("tac", "alert", "Tac 触发紧急处置", data.kind || "安全事件");
    });
    this.bind("tac-review-start", () => this.setLayer("tac", { status: "monitoring", label: "快速风险复核", detail: "检查传统阈值未覆盖的危险" }));
    this.bind("tac-decision", data => {
      this.push("tacEvents", { type: "decision", at: Date.now(), data });
      this.setLayer("tac", { status: data.decision?.urgent ? "alert" : "monitoring", label: data.decision?.urgent ? "发现额外风险" : "风险复核完成", detail: data.decision?.reason || "继续监控" });
    });
    this.bind("tac-idle", () => this.setLayer("tac", { status: "monitoring", label: "监控中", detail: "紧急处置结束" }));
    this.bind("combat-jump-attack", data => {
      this.push("tacEvents", { type: "jump-attack", at: Date.now(), data });
      this.timeline("tac", "success", "Tac 跳砍挥出", "下落时发出单次挥砍；命中与暴击由服务端结算");
    });
    this.bind("death", data => {
      this.push("tacEvents", { type: "death", at: Date.now(), data });
      this.setLayer("tac", { status: "danger", label: "角色死亡", detail: "等待重生" });
      this.timeline("tac", "danger", "Tac 检测到死亡", "等待服务器重生");
    });
    this.bind("death-loot-recovery-start", data => {
      this.push("tacEvents", { type: "death-loot-recovery-start", at: Date.now(), ...data });
      this.setLayer("tac", { status: "alert", label: "回收死亡掉落", detail: data.target ? `前往 ${data.target.join(", ")}` : "寻找掉落物" });
      this.timeline("tac", "recovery", "开始回收死亡掉落", data.target ? data.target.join(", ") : "寻找掉落物");
    });
    this.bind("death-loot-recovery-complete", data => {
      this.push("tacEvents", { type: "death-loot-recovery-complete", at: Date.now(), ...data });
      this.setLayer("tac", { status: "success", label: "掉落回收完成", detail: `重新装备 ${data.equipped?.length || 0} 件` });
      this.timeline("tac", "success", "死亡掉落回收完成", `重新装备 ${data.equipped?.length || 0} 件`);
    });
    this.bind("death-loot-recovery-error", data => {
      this.push("tacEvents", { type: "death-loot-recovery-error", at: Date.now(), ...data });
      this.timeline("tac", "error", "死亡掉落回收失败", data.error?.message || data.stage || "未知错误");
    });
    this.bind("error", data => this.push("runtimeEvents", { type: "error", at: Date.now(), error: cleanError(data?.error || data) }));
    this.bind("agent-output", data => this.push("agentOutputs", { at: Date.now(), ...data }));
    this.bind("llm-trace", data => {
      this.push("llmCalls", { at: Date.now(), ...data });
      const layer = data.provider === "reflection" ? "reflection" : data.provider === "strategic" ? "strategic" : data.provider === "tac" ? "tac" : "distribution";
      const label = layer === "reflection" ? "Reflection" : layer === "strategic" ? "Strategy" : layer === "tac" ? "Tac" : "Distribution";
      if (data.type === "llm-request") this.timeline(layer, "start", `${label} 模型请求发送`, data.model || "LLM");
      if (data.type === "llm-response") this.timeline(layer, "success", `${label} 模型响应返回`, data.model || "LLM");
      if (data.type === "llm-error") this.timeline(layer, "error", `${label} 模型请求失败`, data.error?.message || "LLM error");
      const usage = data.usage;
      if (data.type === "llm-response") {
        const provider = data.provider || "unknown";
        const providerUsage = this.state.tokenUsage.byProvider[provider] || emptyUsage();
        addUsage(providerUsage, usage);
        if (provider !== "reflection") addUsage(this.state.tokenUsage, usage);
        this.state.tokenUsage.byProvider[provider] = providerUsage;
      }
    });
    this.bind("debug-hint", hint => {
      this.push("debugHints", hint);
      this.timeline("strategy", "hint", "收到调试提示", hint.text);
    });
    this.bind("reflection-start", () => {
      this.setLayer("reflection", { status: "running", label: "总结中", startedAt: Date.now(), detail: "整理经验、失败和人工提示" });
      this.timeline("reflection", "start", "Reflection 开始总结", "整理运行记录");
    });
    this.bind("reflection-output", data => {
      this.state.reflection = data;
      this.setLayer("reflection", { status: "success", label: "总结已更新", detail: `${data.lessons?.length || 0} 条经验` });
      this.timeline("reflection", "success", "Reflection 输出总结", `${data.lessons?.length || 0} 条经验`);
    });
    this.bind("reflection-error", data => {
      this.setLayer("reflection", { status: "error", label: "总结失败", detail: data.error?.message || "未知错误" });
      this.timeline("reflection", "error", "Reflection 出错", data.error?.message || "未知错误");
    });
    this.bind("memory-archive-output", data => {
      if (data.entry) {
        const entries = (this.state.memoryArchive.entries || []).filter(item => item.key !== data.entry.key);
        entries.push(data.entry);
        this.state.memoryArchive.entries = entries.slice(-120);
      }
      if (data.summary) this.state.memoryArchive.latestSummary = data.summary;
      this.state.memoryArchive.updatedAt = Date.now();
      this.setLayer("memory", { status: "success", label: "记忆已归档", detail: data.entry?.summary || `${data.count || 0} 条长期记忆` });
      this.timeline("memory", "success", "Memory 归档更新", data.entry?.summary || "经验已写入长期记忆");
    });
    this.unsubscribers.push(worldModel.events.on("snapshot", snapshot => {
      this.state.status = snapshot.status && !snapshot.status.alive ? "dead" : snapshot.status?.ready ? "online" : "waiting";
      this.state.environment = snapshot;
    }));
    this.unsubscribers.push(worldModel.events.on("error", error => this.push("runtimeEvents", { type: "observation-error", at: Date.now(), error: cleanError(error) })));
  }

  bind(type, callback) { this.unsubscribers.push(this.eventBus.on(type, callback)); }

  setLayer(name, patch) {
    const previous = this.state.layers[name] || {};
    const now = Date.now();
    this.state.layers[name] = { ...previous, ...patch, updatedAt: now, durationMs: previous.startedAt ? now - previous.startedAt : previous.durationMs || 0 };
  }

  timeline(layer, type, label, detail = "") {
    this.state.timeline.push({ at: Date.now(), layer, type, label, detail });
    if (this.state.timeline.length > MAX_TIMELINE) this.state.timeline.splice(0, this.state.timeline.length - MAX_TIMELINE);
  }

  push(key, item) {
    this.state[key].push(item);
    const limit = key === "llmCalls" ? 500 : MAX_ITEMS;
    if (this.state[key].length > limit) this.state[key].splice(0, this.state[key].length - limit);
  }

  addAgentOutput({ agent = "unknown", output, taskId = null, metadata = {} } = {}) {
    const entry = { agent, output, taskId, metadata, at: Date.now() };
    this.eventBus.emit("agent-output", entry);
    return entry;
  }

  snapshot() {
    const archivedReflection = this.memoryArchive?.snapshot()?.latestSummary;
    const reflection = (archivedReflection?.updatedAt || 0) > (this.state.reflection?.updatedAt || 0) ? archivedReflection : this.state.reflection;
    const actionItem = item => item ? { action: item.action, source: item.source, planId: item.planId || null, batchId: item.batchId, priority: item.priority, prefetched: Boolean(item.prefetchedFor), queuedAt: item.queuedAt, startedAt: item.startedAt || null, task: item.task ? { id: item.task.id, title: item.task.title, goal: item.task.goal } : null } : null;
    const planItem = plan => plan ? { planId: plan.planId, tasks: plan.tasks?.map(task => ({ id: task.id, title: task.title, goal: task.goal, actions: task.actions })) || [] } : null;
    return {
      ...this.state,
      workQueue: {
        paused: this.executor?.paused || false,
        running: actionItem(this.executor?.running),
        pending: (this.executor?.queue || []).map(actionItem),
        task: this.runner?.snapshot() || null,
        nextPlan: planItem(this.runner?.queuedPlan || this.executor?.queuedPlan),
        revision: planItem(this.runner?.pendingRevision)
      },
      automation: this.executor?.tickStats?.() || null,
      timing: this.prefetch?.snapshot() || null,
      environment: this.state.environment,
      earlyFlow: estimateEarlySurvivalProgress({
        environment: this.state.environment || {},
        nativeState: this.executor?.nativeState,
        task: this.executor?.running?.task || this.executor?.running,
        progressLedger: typeof this.progressLedger === "function" ? this.progressLedger() : this.progressLedger
      }),
      lastStrategyInput: this.state.lastStrategyInput,
      lastStrategy: this.state.lastStrategy,
      lastStrategicInput: this.state.lastStrategicInput,
      lastStrategic: this.state.lastStrategic,
      lastDistributionInput: this.state.lastDistributionInput,
      lastDistribution: this.state.lastDistribution,
      reflection,
      memoryArchive: this.memoryArchive?.snapshot({ limit: 120 }) || this.state.memoryArchive,
      memoryContext: this.memoryArchive?.contextSnapshot() || { entries: [], updatedAt: 0 }
    };
  }

  close() { for (const unsubscribe of this.unsubscribers) unsubscribe(); }
}
