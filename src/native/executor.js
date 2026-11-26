import { randomUUID } from "node:crypto";
import { errorData } from "./bridge.js";

const RETRYABLE_READ_FAILURES = new Set(["network_error", "request_timeout", "api_unavailable", "block_check_failed", "observation_failed"]);
const RESUMABLE_ACTIONS = new Set(["chop_tree", "mine_vein", "fishbone_mine", "explore_cave", "gather_resources", "move_to", "route_navigate", "staircase_down", "staircase_up", "build_base", "build_house"]);

export class NativeExecutor {
  constructor({ bridge, eventBus }) {
    this.bridge = bridge; this.events = eventBus; this.queue = []; this.running = null; this.paused = false;
    this.workProgress = null; this.activeTask = null; this.activePlanId = null; this.queuedPlan = null;
    this.pendingRevision = null; this.handle = null; this.idleWaiters = []; this.nativeState = null; this.idleNotified = false; this.knownPlanIds = new Set(); this.stats = { automatedMs: 0, waitingMs: 0, startedAt: Date.now(), lastAt: Date.now() };
  }
  get busy() { return !!this.running; }
  get queueLength() { return this.queue.length; }
  get currentAction() { return this.running?.action || null; }
  enqueue(action, options = {}) {
    const source = options.source || "action:compat";
    const type = action?.type === "attack" || action?.type === "jump_attack" ? "jump_attack" : action?.type;
    if (!type) return Promise.reject(Object.assign(new Error("缺少自动化脚本类型"), { code: "bad_args" }));
    const task = { id: `${source}-${randomUUID()}`, title: source, goal: "Tac 自动化动作", actions: [{ type, params: action.params || {} }] };
    return new Promise((resolve, reject) => {
      const item = { action: task.actions[0], task, taskLast: true, planId: task.id, source, priority: options.priority || 0, queuedAt: Date.now(), resolve, reject };
      this.queue.push(item); this.resume();
    });
  }
  snapshot() { return { activePlanId: this.activePlanId, activeTask: this.activeTask, currentAction: this.currentAction, completedActions: this.completedActions || 0, workProgress: this.workProgress, queuedTasks: [...new Set(this.queue.map(item => item.task?.title).filter(Boolean))], native: true, ...this.tickStats() }; }
  enqueuePlan(plan, { prefetchedFor = null } = {}) {
    if (!plan?.tasks?.length) return false;
    if (plan.planId && this.knownPlanIds.has(plan.planId)) {
      this.events.emit("distribution-plan-duplicate-ignored", { planId: plan.planId, queueLength: this.queue.length });
      return false;
    }
    if (plan.planId) {
      this.knownPlanIds.add(plan.planId);
      if (this.knownPlanIds.size > 512) this.knownPlanIds.delete(this.knownPlanIds.values().next().value);
    }
    if (this.running) this.queuedPlan = plan;
    for (const task of plan.tasks) for (let i = 0; i < task.actions.length; i++) this.queue.push({ action: task.actions[i], actionIndex: i, source: `action:${task.id}`, task, planId: plan.planId, batchId: plan.planId, priority: 0, queuedAt: Date.now(), taskLast: i === task.actions.length - 1, prefetchedFor });
    this.events.emit("plan-queued", { planId: plan.planId, task: plan.tasks[0].title });this.pump();return true;
  }
  tickStats() { const now = Date.now();this.stats[this.running ? "automatedMs" : "waitingMs"] += now - this.stats.lastAt;this.stats.lastAt = now;return { ...this.stats, busyRatio: this.stats.automatedMs / Math.max(1, now - this.stats.startedAt) }; }
  pump() {
    if (this.paused || this.running || !this.queue.length) { if (!this.running) { this.idleWaiters.splice(0).forEach(resolve => resolve());if(!this.idleNotified){this.idleNotified=true;this.events.emit("native-idle", {});} }return; }
    this.idleNotified=false;
    this.tickStats();const item = this.queue.shift();this.running = item;this.queuedPlan = null;
    item.runId = randomUUID();
    item.startedAt = Date.now();this.workProgress = null;
    if (this.activeTask?.id !== item.task?.id || this.activePlanId !== item.planId) {
      this.activeTask = item.task;this.activePlanId = item.planId;this.completedActions = 0;
      if (item.task) this.events.emit("task-start", { taskId: item.task.id, planId: item.planId, task: item.task });
    }
    this.events.emit("action-start", { ...item, startedAt: item.startedAt, queueWaitMs: item.startedAt - item.queuedAt });
    item.initialSteps = item.initialSteps ?? item.action.params?.steps;
    const handle = this.bridge.run(item.action.type, item.action.params, { onProgress: progress => {
      this.workProgress = progress;if (progress.resumeParams) item.action.params = { ...item.action.params, ...progress.resumeParams };
      if (["staircase_down", "staircase_up"].includes(item.action.type) && progress.phase === item.action.type && Number.isFinite(item.initialSteps) && Number.isFinite(progress.completed)) item.action.params.steps = Math.max(1, item.initialSteps - progress.completed);
      this.events.emit("action-progress", { runId: item.runId, action: item.action, source: item.source, planId: item.planId, taskId: item.task?.id || null, task: item.task, progress });
      if (progress.phase === "preflight") this.events.emit("action-preflight", { ...progress, ok: !progress.missing?.length, source: item.source });
    } });this.handle = handle;
    handle.promise.then(outcome => {
      item.outcome = outcome;this.completedActions++;item.resolve?.(outcome);this.nativeState=outcome.state;this.events.emit("native-state", outcome.state);
      this.events.emit("action-end", { action: item.action, actionIndex: item.actionIndex || 0, taskLast: item.taskLast, source: item.source, planId: item.planId, taskId: item.task?.id || null, task: item.task, result: outcome.result, durationMs: Date.now() - item.startedAt, queueWaitMs: item.startedAt - item.queuedAt });
      if (item.action.type === "fishbone_mine" && outcome.result?.stopReason === "resume_required") {
        item.incomplete = true;
        this.queue = [];
        this.queuedPlan = null;
        const warning = { warning: true, code: "work_incomplete", message: "鱼骨任务未达目标，已保留原任务并停止后续队列", result: outcome.result };
        item.warning = warning;
        this.events.emit("task-incomplete", { taskId: item.task?.id || null, planId: item.planId, task: item.task, action: item.action, result: outcome.result });
        this.events.emit("action-warning", { action: item.action, source: item.source, planId: item.planId, taskId: item.task?.id || null, task: item.task, warning });
      } else if (item.action.type === "fishbone_mine" && !["lane_complete", "resume_required", "target_reached"].includes(outcome.result?.stopReason)) {
        const reason = outcome.result?.stopReason || "stopped";
        const message = reason === "danger" ? "鱼骨施工因生存风险停止，等待 Tac 处理" : reason === "no_tool" ? "鱼骨施工因缺少镐停止，等待重新分发" : reason === "inventory_full" ? "鱼骨施工因背包已满停止，先存储后再继续" : "鱼骨施工停止";
        item.warning = { warning: true, code: `fishbone_${reason}`, message, result: outcome.result };
        this.queue = [];
        this.events.emit("action-warning", { action: item.action, source: item.source, planId: item.planId, taskId: item.task?.id || null, task: item.task, warning: item.warning });
        if (item.task) this.events.emit("task-warning", { taskId: item.task.id, planId: item.planId, warning: item.warning, final: true });
      } else if (outcome.result?.warning) {
        item.warning = outcome.result;
        this.events.emit("action-warning", { action: item.action, source: item.source, planId: item.planId, taskId: item.task?.id || null, task: item.task, warning: outcome.result });
        this.queue = this.queue.filter(next => next.planId !== item.planId);
        if (item.task) this.events.emit("task-warning", { taskId: item.task.id, planId: item.planId, warning: outcome.result, final: true });
      } else if (item.taskLast) this.events.emit("task-complete", { taskId: item.task.id, planId: item.planId });
    }, error => {
      item.error = error;item.reject?.(error);
      if (error.code === "cancelled") return;
      const httpStatus = Number(error.details?.httpStatus);
      const transientApiFailure = RETRYABLE_READ_FAILURES.has(error.code) || httpStatus === 408 || httpStatus === 429 || httpStatus >= 500;
      if (transientApiFailure && RESUMABLE_ACTIONS.has(item.action.type) && (item.retryCount || 0) < 1) {
        const retry = { ...item, error: null, retryCount: (item.retryCount || 0) + 1, queuedAt: Date.now(), startedAt: null };
        this.queue.unshift(retry);
        this.events.emit("action-retry-scheduled", { action: item.action, taskId: item.task?.id || null, planId: item.planId, attempt: retry.retryCount, reason: errorData(error) });
        return;
      }
      this.events.emit("action-error", { action: item.action, source: item.source, planId: item.planId, taskId: item.task?.id || null, task: item.task, error, durationMs: Date.now() - item.startedAt });
      // Later tasks may depend on this output. Discard the dependent chain;
      // never issue the same failed API repeatedly as a generic retry policy.
      this.queue = this.queue.filter(next => next.planId !== item.planId);
      if (item.task) this.events.emit("task-error", { taskId: item.task.id, planId: item.planId, error: errorData(error), final: true });
    }).finally(() => {
      if (item.error || item.warning || item.incomplete) this.discardPrefetched(item.error?.code || item.warning?.code || "incomplete");
      this.events.emit("action-settled", { runId: item.runId, action: item.action, source: item.source, priority: item.priority, durationMs: Date.now() - item.startedAt, error: item.error, warning: item.warning, incomplete: item.incomplete, taskLast: item.taskLast });
      this.tickStats();this.running = null;this.handle = null;this.workProgress = null;
      if (item.priority >= 100) this.paused = true;
      if (item.taskLast || item.error || item.warning) this.activeTask = null;
      this.pump();
    });
  }
  async interrupt({ resume = false } = {}) {
    this.paused = true;const item = this.running, handle = this.handle;
    if (handle) await handle.cancel();
    if (this.running) await new Promise(resolve => this.idleWaiters.push(resolve));
    const resumable = new Set(["chop_tree", "mine_vein", "fishbone_mine", "explore_cave", "gather_resources", "move_to", "route_navigate", "navigation_recover", "staircase_up", "staircase_down", "build_workarea", "build_base", "build_house"]);
    if (resume && item?.error?.code === "cancelled" && resumable.has(item.action.type)) this.queue.unshift({ ...item, error: null, queuedAt: Date.now(), startedAt: null });
    else if (item?.error?.code === "cancelled" && item.task) this.queue = this.queue.filter(next => next.planId !== item.planId);
    return item;
  }
  async stop() { await this.interrupt(); }
  resume() { this.paused = false;this.pump(); }
  async priority(action, source = "tac") {
    if (this.running) throw new Error("高优先级脚本启动前必须等待普通动作停止");
    const task = { id: `${source}-${randomUUID()}`, title: source, actions: [action] };
    const item = { action, task, taskLast: true, planId: task.id, source, priority: 100, queuedAt: Date.now() };
    this.queue.unshift(item);
    this.resume();
    if (this.running) await new Promise(resolve => this.idleWaiters.push(resolve));
    return { outcome: item.outcome, error: item.error ? errorData(item.error) : null, warning: item.warning || null };
  }
  cancelPending() { this.queue = [];this.queuedPlan = null; }
  discardPrefetched(reason) {
    const discarded = new Set(this.queue.filter(item => item.prefetchedFor).map(item => item.planId));
    this.queue = this.queue.filter(item => !item.prefetchedFor);
    if (discarded.has(this.queuedPlan?.planId)) this.queuedPlan = null;
    if (discarded.size) this.events.emit("distribution-plan-discarded", { planIds: [...discarded], reason });
  }
  pause() { this.paused = true; }
}
