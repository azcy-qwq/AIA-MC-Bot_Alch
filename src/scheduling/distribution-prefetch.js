import { plannedWork, timingProfile } from "./timing-model.js";

const finite = value => typeof value === "number" && Number.isFinite(value);
const ordinary = item => item && (item.priority || 0) < 100 && !["tac", "death-recovery"].includes(item.source);
const itemKey = item => `${item.planId}:${item.task?.id}:${item.actionIndex || 0}`;

export class DistributionPrefetch {
  constructor({ model, modelName = "default", eventBus, executor, getSnapshot, canPrefetch, requestPlan, now = Date.now }) {
    Object.assign(this, { model, modelName, events: eventBus, executor, getSnapshot, canPrefetch, requestPlan, now });
    this.current = null; this.requested = new Set(); this.inflight = false; this.retryAt = 0;
    this.pendingPlan = null; this.revision = 0;
    this.lastDecision = null; this.lastHandoff = null; this.lastFinished = null; this.state = null;
    this.unsubscribers = [
      eventBus.on("action-start", data => this.begin(data)),
      eventBus.on("action-progress", data => this.progress(data)),
      eventBus.on("action-settled", data => this.finish(data)),
      eventBus.on("native-idle", () => this.releasePending()),
      eventBus.on("distribution-measured", data => model.observeDistribution({ model: modelName, ...data }))
    ];
  }
  async start() { await this.model.load(); this.timer = setInterval(() => this.tick(), 500); this.timer.unref?.(); }
  begin(data) {
    if (!ordinary(data)) return;
    const snapshot = this.getSnapshot(), action = structuredClone(data.action);
    this.current = { runId: data.runId, action, key: timingProfile(action, snapshot), units: plannedWork(action, snapshot, this.executor.nativeState), completed: 0, startedAt: data.startedAt || this.now(), lastUnitAt: this.now(), lastUnits: 0, lastJournalAt: this.now(), itemKey: itemKey(data), liveRate: null };
    this.model.journal({ kind: "action-start", runId: data.runId, key: this.current.key, units: this.current.units });
    if (this.lastFinished) {
      this.lastHandoff = { gapMs: Math.max(0, this.now() - this.lastFinished.at), from: this.lastFinished.type, to: action.type, at: this.now(), prefetched: Boolean(data.prefetchedFor) };
      this.model.journal({ kind: "handoff", ...this.lastHandoff }); this.lastFinished = null;
    }
    this.tick();
  }
  progress(data) {
    const current = this.current, p = data.progress;
    if (!current || (data.runId && current.runId !== data.runId) || !p || ["starting", "finished", "warning"].includes(p.phase)) return;
    let completed = p.workCompleted, total = p.workTotal;
    if (!finite(total) && /^(staircase_up|staircase_down|build_workarea|pillar|smelt)$/.test(p.phase)) { completed = p.completed; total = p.total; }
    if (finite(total) && total >= 0 && finite(completed) && completed >= 0) {
      current.units = total; current.completed = Math.min(total, completed);
      const delta = current.completed - current.lastUnits, elapsed = this.now() - current.lastUnitAt;
      if (delta > 0 && elapsed > 0) {
        const rate = elapsed / delta;
        current.liveRate = current.liveRate === null ? rate : 0.65 * current.liveRate + 0.35 * rate;
        this.model.observeRate(current.key, elapsed, delta);
        current.lastUnitAt = this.now(); current.lastUnits = current.completed;
      }
    }
    if (finite(p.remainingMs) && p.remainingMs >= 0) current.nativeEstimate = { ms: p.remainingMs, at: this.now() };
    if (this.now() - current.lastJournalAt >= 10000) {
      this.model.journal({ kind: "action-progress", runId: current.runId, key: current.key, completed: current.completed, total: current.units, elapsedMs: this.now() - current.startedAt }); current.lastJournalAt = this.now();
    }
    this.tick();
  }
  finish(data) {
    if (!ordinary(data)) return;
    const current = this.current;
    if (current && current.runId === data.runId) {
      const success = !data.error && !data.warning && !data.incomplete;
      this.model.observeAction({ key: current.key, runId: current.runId, units: current.units, durationMs: data.durationMs, success, errorCode: data.error?.code || data.warning?.code });
      if (success) this.lastFinished = { at: this.now(), type: current.action.type };
      else { this.lastFinished = null; this.invalidate(data.error?.code || data.warning?.code || "incomplete"); }
      this.current = null;
    }
  }
  invalidate(reason) {
    this.revision++; this.pendingPlan = null;
    this.requested.clear(); this.retryAt = this.now() + 1000;
    if (["generating", "queued", "ready"].includes(this.lastDecision?.status)) this.lastDecision = { ...this.lastDecision, status: "discarded", reason };
    this.executor.discardPrefetched?.(reason);
  }
  remaining() {
    const current = this.current;
    if (!current || !ordinary(this.executor.running)) return null;
    const elapsedMs = Math.max(0, this.now() - current.startedAt), history = this.model.predict(current.key, current.units);
    let remainingMs = history ? Math.max(0, history.expectedMs - elapsedMs) : null;
    let lowerMs = history ? Math.max(0, history.lowerMs - elapsedMs) : null;
    let source = history?.source || "unknown", stalled = false;
    if (current.liveRate && finite(current.units)) {
      const remainingUnits = Math.max(0, current.units - current.completed), since = this.now() - current.lastUnitAt;
      // Only discount the currently executing unit; do not count down an
      // unreported long script to zero during a pathfinding stall.
      const discount = Math.min(since, current.liveRate * 0.8);
      remainingMs = Math.max(0, remainingUnits * current.liveRate - discount);
      lowerMs = remainingMs * 0.8; source = "current-progress";
      stalled = since > Math.max(30000, current.liveRate * 4);
    } else if (current.nativeEstimate?.ms > 0) {
      remainingMs = Math.max(current.nativeEstimate.ms * 0.2, current.nativeEstimate.ms - (this.now() - current.nativeEstimate.at));
      lowerMs = remainingMs * 0.8; source = "native-progress";
    }
    const pending = this.executor.queue.filter(item => ordinary(item) && !item.prefetchedFor);
    for (const item of pending) {
      const snapshot = this.getSnapshot(), units = plannedWork(item.action, snapshot, this.executor.nativeState), prediction = this.model.predict(timingProfile(item.action, snapshot), units);
      if (!prediction || remainingMs === null) return { remainingMs: null, lowerMs: null, elapsedMs, source: "unknown-queued-work", stalled, pending: pending.length };
      remainingMs += prediction.expectedMs; lowerMs += prediction.lowerMs;
    }
    // Cold-start excavation needs actual progress, not an invented deadline.
    const needsProgress = ["chop_tree", "mine_vein", "fishbone_mine", "staircase_up", "staircase_down", "build_workarea", "build_base"].includes(current.action.type);
    return { remainingMs, lowerMs, elapsedMs, source, stalled, ready: !needsProgress || current.completed > 0 || (history?.samples || 0) >= 3, completed: current.completed, total: current.units, samples: history?.samples || 0, rateSamples: history?.rateSamples || 0, pending: pending.length };
  }
  tick() {
    this.releasePending();
    const work = this.remaining(), generation = this.model.distributionEstimate(this.modelName);
    const queued = Boolean(this.pendingPlan) || this.executor.queue.some(item => item.prefetchedFor);
    this.state = { work, generation, forecast: this.lastDecision, lastHandoff: this.lastHandoff, counts: { ...this.model.data.counts }, queued, generating: this.inflight };
    if (!work?.ready || work.stalled || !finite(work.lowerMs) || work.lowerMs > generation.leadMs || queued || this.inflight || this.now() < this.retryAt || !this.canPrefetch()) return;
    const pending = this.executor.queue.filter(ordinary), frontier = pending.at(-1) || this.executor.running, key = itemKey(frontier);
    if (this.requested.has(key)) return;
    this.requested.add(key); if (this.requested.size > 100) { this.requested.clear(); this.requested.add(key); }
    this.inflight = true; const revision = this.revision;
    const decision = { at: this.now(), frontier: key, remainingMs: work.remainingMs, lowerMs: work.lowerMs, leadMs: generation.leadMs, status: "generating" };
    this.lastDecision = decision; this.model.journal({ kind: "prefetch", ...decision }); this.events.emit("distribution-prefetch", decision);
    Promise.resolve().then(() => this.requestPlan(decision)).then(plan => {
      if (revision !== this.revision) return;
      if (plan?.tasks?.length) {
        this.pendingPlan = { plan, frontier: key, createdAt: this.now() };
        this.events.emit("distribution-plan-ready", { planId: plan.planId, task: plan.tasks[0].title });
      }
      if (this.lastDecision === decision) this.lastDecision = { ...decision, status: plan?.tasks?.length ? "ready" : plan ? "empty" : "failed" };
      if (!plan) { this.requested.delete(key); this.retryAt = this.now() + 2000; }
    }).catch(error => {
      if (revision !== this.revision) return;
      this.lastDecision = { ...decision, status: "failed", reason: error.message };
      this.requested.delete(key); this.retryAt = this.now() + 2000;
    }).finally(() => { this.inflight = false; this.releasePending(); });
  }
  releasePending() {
    const pending = this.pendingPlan;
    if (!pending || this.inflight || this.executor.busy || this.executor.queueLength || this.executor.paused || !this.canPrefetch()) return false;
    this.pendingPlan = null;
    this.lastDecision = { ...this.lastDecision, status: "released", releasedAt: this.now() };
    this.model.journal({ kind: "prefetch-release", planId: pending.plan.planId, frontier: pending.frontier });
    this.events.emit("distribution-plan-released", { planId: pending.plan.planId, task: pending.plan.tasks[0].title });
    return this.executor.enqueuePlan(pending.plan, { prefetchedFor: pending.frontier });
  }
  snapshot() {
    return { ...this.state, work: this.remaining(), generation: this.model.distributionEstimate(this.modelName), forecast: this.lastDecision, lastHandoff: this.lastHandoff, generating: this.inflight, queued: Boolean(this.pendingPlan) || this.executor.queue.some(item => item.prefetchedFor), pendingPlan: this.pendingPlan ? { planId: this.pendingPlan.plan.planId, task: this.pendingPlan.plan.tasks[0].title, createdAt: this.pendingPlan.createdAt } : null };
  }
  stop() { clearInterval(this.timer); this.revision++; this.pendingPlan = null; }
  async close() { this.stop(); this.unsubscribers.splice(0).forEach(off => off()); await this.model.flush(); }
}
