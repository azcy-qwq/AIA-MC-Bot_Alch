import { Agent } from "../base.js";
import { assertCredentials, loadConfig } from "./config.js";
import { EventBus } from "./core/events.js";
import { WorldModel } from "./core/world-model.js";
import { OpenAICompatibleProvider } from "./llm/provider.js";
import { StrategicEngine } from "./strategy/strategic-engine.js";
import { NativeBridge } from "./native/bridge.js";
import { NativeExecutor } from "./native/executor.js";
import { NativeDistribution } from "./native/distribution.js";
import { TacController } from "./tac/tac-controller.js";
import { NativeTacResponder } from "./tac/native-responder.js";
import { DebugStore } from "./debug/debug-store.js";
import { DebugServer } from "./debug/debug-server.js";
import { ReflectionEngine } from "./reflection/reflection-engine.js";
import { StrategyMemory } from "./strategy/memory.js";
import { MemoryArchive } from "./memory/memory-archive.js";
import { RouteMemory } from "./navigation/route-memory.js";
import { STRATEGIC_INTERVAL_MS } from "./strategy/tactical-reference.js";
import { estimateEarlySurvivalProgress } from "./strategy/early-survival-flow.js";
import { TimingModel } from "./scheduling/timing-model.js";
import { DistributionPrefetch } from "./scheduling/distribution-prefetch.js";
import { ProgressLedger } from "./strategy/progress-ledger.js";

export function createRuntime({ config = loadConfig(), api, strategyProvider, eventBus = new EventBus() } = {}) {
  const client = api || new Agent(config.api.username, config.api.password, { baseUrl: config.api.baseUrl });
  const worldModel = new WorldModel(client, { observationIntervalMs: config.intervals.observationMs });
  const routes = new RouteMemory({ filePath: config.routes?.filePath || "data/routes.json" });
  const bridge = new NativeBridge({ api: client, stateFile: config.native?.stateFile || "data/native-state.json", imports: Object.fromEntries(routes.anchors), onApi: data => {
    const current = executor?.running;
    eventBus.emit("native-api", { ...data, planId: current?.planId || null, taskId: current?.task?.id || null, source: current?.source || "C++ 自动化", parentAction: current?.action || null });
  } });
  const executor = new NativeExecutor({ bridge, eventBus });
  const llm = new OpenAICompatibleProvider({ ...config.llm, ...config.sessionBudget, onTrace: trace => eventBus.emit("llm-trace", trace) });
  const provider = strategyProvider || llm;
  const memory = new StrategyMemory({ filePath: config.memory?.filePath || "data/strategy-memory.json" });
  const archive = new MemoryArchive({ filePath: config.memoryArchive?.filePath || "data/memory-archive.json", eventBus });
  const progressLedger = new ProgressLedger({ filePath: config.progress?.filePath || "data/progress-state.json" });
  const progressSnapshot = () => progressLedger.snapshot();
  const inventoryBrief = inventory => bridge.inventoryBrief(inventory);
  const strategy = new StrategicEngine({ provider, eventBus, sessionBudget: config.sessionBudget, minReplanMs: config.intervals.strategicMinReplanMs || STRATEGIC_INTERVAL_MS, routeMemory: routes, memory, memoryArchive: archive, inventoryBrief, filePath: config.runtimeState?.filePath || "data/runtime-state.json" });
  const distribution = new NativeDistribution({ provider, eventBus, memory, memoryArchive: archive, inventoryBrief, progressLedger: progressSnapshot, filePath: config.distributionState?.filePath || "data/distribution-state.json" });
  const reflection = new ReflectionEngine({ provider: llm, eventBus, sessionBudget: config.sessionBudget, minIntervalMs: config.intervals.reflectionMinMs || 135000, filePath: config.reflection?.filePath || "data/reflection-latest.json" });
  const debugStore = new DebugStore({ worldModel, eventBus, memoryArchive: archive, executor, runner: null, progressLedger: progressSnapshot });
  const debugServer = config.debug.enabled ? new DebugServer({ store: debugStore, host: config.debug.host, port: config.debug.port, onHint: ({ text }) => ({ ok: true, hint: distribution.addDebugHint(text) }), onReflection: () => reflection.summarize(input(), { force: true }) }) : null;
  let stopped = false, reflectionTimer, distributionRetryTimer, distributionRetryAttempt = 0, queueEmptyTimer, queueEmptyAttempt = 0, distributionFailureEpoch = 0, hintRevision = 0, distributionDispatch = null, idleEnvironmentKey = null, active = false, nativeTac = null, tacBusy = false, offSnapshot = null, lastStrategicPhase = null;
  const timingModel = new TimingModel({ ...config.timing, onError: error => eventBus.emit("runtime-warning", { type: "timing-storage", message: error.message }) });
  const prefetch = new DistributionPrefetch({ model: timingModel, modelName: provider.model || "custom", eventBus, executor, getSnapshot: () => worldModel.latest, canPrefetch: () => active && !stopped && !tacBusy && !executor.paused && !distribution.running && !distributionDispatch, requestPlan: () => distribute(true, true, true) });
  debugStore.prefetch = prefetch;
  const input = () => ({ environment: worldModel.latest, events: [...(debugStore.snapshot().timeline || []), ...(debugStore.snapshot().toolCalls || [])], hints: distribution.debugHints, currentPlan: distribution.currentPlan, strategicPlan: strategy.currentPlan, memoryArchive: archive.snapshot() });
  const waitReady = async () => { for (let i = 0; i < 90; i++) { try { const s = (await client.status()).result;if(s?.ready&&s.alive)return s; } catch {} await new Promise(r => setTimeout(r, 1000)); } throw new Error("等待 Agent 就绪超时"); };
  const runDistribution = async (nextTask = false, allowBusy = false, speculative = false, repair = false) => {
    if (stopped || !active || tacBusy || (!allowBusy && (executor.busy || executor.queueLength))) return;
    if(distribution.modelBlocked?.code==="llm_budget_exhausted"||Date.now()<(distribution.modelBlocked?.retryAt||0))return;
    if (distribution.lastFailure?.error?.code === "api_compatibility_unresolved" && !distribution.lastFailure.manualRetry) {
      eventBus.emit("distribution-blocked", { reason: distribution.lastFailure.error.message, error: distribution.lastFailure.error });
      return null;
    }
    let prefetchedFor = speculative ? executor.running?.runId || "queue-tail" : null;
    for (let refresh = 0; refresh < 2; refresh++) {
      const epoch = distributionFailureEpoch, requestedHintRevision = hintRevision, execution = executor.snapshot();
      let plan;
      try { plan = await distribution.replan(worldModel.latest, { strategicPlan: strategy.currentPlan, execution, queuedTasks: execution.queuedTasks, nativeState: executor.nativeState, nextTask, repair }); }
      catch { return null; }
      if (stopped || !active) return null;
      if (epoch !== distributionFailureEpoch) {
        eventBus.emit("distribution-plan-discarded", { planIds: [plan?.planId], reason: "请求期间发生失败、危险或人工提示，旧预测已作废" });
        if (speculative) return null;
        if (tacBusy || ((executor.busy || executor.queueLength) && requestedHintRevision === hintRevision)) return null;
        nextTask = Boolean(executor.busy || executor.queueLength); prefetchedFor = nextTask ? executor.running?.runId || "queue-tail" : null;
        continue;
      }
      if (plan?.tasks?.length) {
        clearTimeout(queueEmptyTimer); queueEmptyAttempt = 0;
        if (!speculative) {
          const enqueued = executor.enqueuePlan(plan, { prefetchedFor });
          eventBus.emit(enqueued ? "distribution-plan-enqueued" : "distribution-plan-enqueue-skipped", { planId: plan.planId, taskCount: plan.tasks.length, queueLength: executor.queueLength, busy: executor.busy, prefetchedFor, reason: enqueued ? null : "duplicate-plan" });
        }
      } else {
        eventBus.emit("distribution-plan-empty", { planId: plan?.planId || null, reason: plan?.rationale || "no-tasks", speculative });
        scheduleQueueEmptyRecheck();
      }
      return plan;
    }
    return null;
  };
  // All wakeups share both generation AND queue insertion. Sharing only the
  // provider promise used to enqueue the same result twice at an idle boundary.
  const distribute = (...args) => {
    const speculative = Boolean(args[2]);
    const repair = Boolean(args[3]);
    if (distributionDispatch) {
      const pending = distributionDispatch.promise || distributionDispatch;
      if (speculative) return pending;
      if (repair) return pending.then(() => distribute(false, false, false, true));
      const epoch = distributionFailureEpoch;
      return pending.then(plan => {
        const allowBusy = Boolean(args[1]);
        if (epoch === distributionFailureEpoch && !stopped && active && !tacBusy && plan?.tasks?.length && (allowBusy || (!executor.busy && !executor.queueLength))) {
          const enqueued = executor.enqueuePlan(plan);
          eventBus.emit(enqueued ? "distribution-plan-enqueued" : "distribution-plan-enqueue-skipped", { planId: plan.planId, taskCount: plan.tasks.length, queueLength: executor.queueLength, busy: executor.busy, joinedInFlight: true, reason: enqueued ? null : "duplicate-plan" });
        }
        return plan;
      });
    }
    const pending = runDistribution(...args);
    const dispatch = { promise: pending, speculative };
    distributionDispatch = dispatch;
    pending.finally(() => {
      if (distributionDispatch === dispatch) distributionDispatch = null;
      // A failed/discarded speculative response can consume the idle wakeup.
      // Keep a queue-driven wakeup independent of environment changes.
      if (!executor.busy && !executor.queueLength && !prefetch.pendingPlan) scheduleQueueEmptyRecheck();
    }).catch(() => {});
    return pending;
  };
  const environmentKey = snapshot => JSON.stringify({
    dimension: snapshot?.status?.dimension, alive: snapshot?.status?.alive, food: Math.floor(Number(snapshot?.status?.food || 0) / 4),
    health: Math.floor(Number(snapshot?.status?.health || 0) / 4), position: snapshot?.status?.pos?.map(value => Math.floor(Number(value) / 4)),
    inventory: (snapshot?.inventory?.items || []).map(item => [item.name, item.count]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    hostiles: (snapshot?.entities || []).filter(entity => entity.hostile || entity.is_hostile).map(entity => entity.name || entity.type).sort()
  });
  const scheduleQueueEmptyRecheck = () => {
    clearTimeout(queueEmptyTimer);
    if (stopped || !active || tacBusy || executor.busy || executor.queueLength) return;
    if (distribution.modelBlocked?.code === "llm_budget_exhausted") return;
    const delayMs = distribution.modelBlocked?.code === "llm_budget_paced" ? 30000 : Math.min(30000, 1000 * (2 ** queueEmptyAttempt++));
    eventBus.emit("distribution-idle-recheck", { delayMs, attempt: queueEmptyAttempt });
    queueEmptyTimer = setTimeout(() => {
      if (!stopped && active && !tacBusy && !executor.busy && !executor.queueLength) distribute(false, true).catch(error => eventBus.emit("runtime-warning", { type: "distribution-dispatch", error: { message: error.message, code: error.code } }));
    }, delayMs);
  };
  const offIdle = eventBus.on("native-idle", () => setTimeout(() => distribute(false).catch(error => eventBus.emit("runtime-warning", { type: "distribution-dispatch", error: { message: error.message, code: error.code } })), 50));
  const offTacIdle = eventBus.on("tac-idle", () => {
    if (!executor.busy && !executor.queueLength) {
      distribute(false)
        .catch(error => eventBus.emit("runtime-warning", { type: "distribution-dispatch", error: { message: error.message, code: error.code } }))
        .finally(scheduleQueueEmptyRecheck);
    }
  });
  let repairTimer;
  const replanAfterInterruption = data => {
    if (!active || stopped) return;
    if (["tac", "death-recovery"].includes(data?.source)) return;
    if (data?.warning?.code === "workarea_incomplete") return;
    distributionFailureEpoch++;
    prefetch.invalidate("当前工作中断或条件变化");
    clearTimeout(repairTimer);
    repairTimer = setTimeout(() => distribute(false, false, false, true).catch(error => eventBus.emit("runtime-warning", { type: "distribution-dispatch", error: { message: error.message, code: error.code } })), 0);
  };
  const offFailure = eventBus.on("action-error", data => {
    replanAfterInterruption(data);
  });
  const offActionWarning = eventBus.on("action-warning", replanAfterInterruption);
  const offWorkareaBlocked = eventBus.on("distribution-blocked", () => {
    if (!active || stopped || executor.busy || executor.queueLength) return;
    distribute(false, true).catch(error => eventBus.emit("runtime-warning", { type: "distribution-dispatch", error: { message: error.message, code: error.code } }));
  });
  const offActionRetry = eventBus.on("action-retry-scheduled", () => { distributionFailureEpoch++;prefetch.invalidate("网络失败后续跑，旧预测作废"); });
  const offDistributionError = eventBus.on("distribution-error", data => {
    if (stopped || !active) return;
    if (["llm_not_configured", "llm_budget_exhausted"].includes(data.error?.code)) return;
    if (executor.busy || executor.queueLength > 0) return;
    clearTimeout(distributionRetryTimer);
    const delayMs = data.error?.code === "llm_budget_paced" ? 30000 : Math.min(30000, 1000 * (2 ** distributionRetryAttempt++));
    eventBus.emit("distribution-retry-scheduled", { delayMs, attempt: distributionRetryAttempt, error: { message: data.error?.message, code: data.error?.code } });
    distributionRetryTimer = setTimeout(() => {
      if (stopped || !active) return;
      if (!executor.busy && executor.queueLength === 0) distribute(false).catch(error => eventBus.emit("runtime-warning", { type: "distribution-dispatch", error: { message: error.message, code: error.code } }));
    }, delayMs);
  });
  const offDistributionSuccess = eventBus.on("distribution-output", data => {
    if (data.discarded) return;
    distributionRetryAttempt = 0;
    clearTimeout(distributionRetryTimer);
    distributionRetryTimer = null;
    if (!data.plan?.tasks?.length) idleEnvironmentKey = environmentKey(worldModel.latest);
  });
  const offAction = eventBus.on("action-end", data => Promise.allSettled([memory.recordAction(data), archive.recordAction(data)]));
  const offHint = eventBus.on("debug-hint", () => { strategy.debugHints = distribution.debugHints;distributionFailureEpoch++;hintRevision++;prefetch.invalidate("人工提示已更新");if (distribution.lastFailure?.error?.code === "api_compatibility_unresolved") distribution.lastFailure.manualRetry = true;if (active) distribute(executor.busy || executor.queueLength > 0, true).catch(error => eventBus.emit("runtime-warning", { type: "distribution-dispatch", error: { message: error.message, code: error.code } })); });
  let deathEvent = null, progressResetPending = false, wasAlive = false;
  const offDeath = worldModel.events.on("game-event", event => {
    if (event.type === "death") {
      distributionFailureEpoch++;prefetch.invalidate("death");
      deathEvent = { ...event, dimension: worldModel.latest.status?.dimension }; progressResetPending = true; executor.interrupt().catch(() => {});eventBus.emit("death", event);
      bridge.run("record_death", { death: deathEvent }).promise.then(outcome => { executor.nativeState = outcome.state; }).catch(error => eventBus.emit("runtime-warning", { type: "death-memory", error: { message: error.message } }));
    } else if (event.type === "hurt" && !tacBusy) {
      const status = worldModel.latest.status, attacker = event.source_entity?.id || event.likely_attacker?.id || event.likely_attacker?.entity_id;
      const entity = worldModel.latest.entities?.find(e => e.id === attacker);
      if (entity && status && Math.hypot(...status.pos.map((n, i) => n - entity.pos[i])) <= 4) onTac({ urgent: true, kind: "combat", params: { entity_id: entity.id, confirmed_attacker: true } });
    }
  });
  const tacResponder=new NativeTacResponder({executor,events:eventBus,canRun:()=>active&&!stopped,isAlive:()=>Boolean(worldModel.latest.status?.alive),onBusy:value=>{tacBusy=value;},onDecision:()=>{distributionFailureEpoch++;prefetch.invalidate("tac-priority");}});
  const onTac = decision => tacResponder.submit(decision);
  return {
    api: client, worldModel, executor, distribution, strategy, reflection, memory, memoryArchive: archive, timing: prefetch, tac: null, debug: { store: debugStore, server: debugServer }, events: eventBus,
    async start({ requireCredentials = true } = {}) {
      if (debugServer) await debugServer.start();if (requireCredentials) assertCredentials(config);await bridge.check();await prefetch.start();await routes.load();bridge.imports=Object.fromEntries(routes.anchors);await memory.load();await archive.load();await reflection.load();await distribution.load();await strategy.load();await progressLedger.load();await client.login();await client.connect();await waitReady();active=true;await worldModel.refresh();worldModel.start();
       const restored = await bridge.run("inspect_state", {}).promise;executor.nativeState = restored.state;
       await progressLedger.observe(estimateEarlySurvivalProgress({ environment: worldModel.latest, nativeState: executor.nativeState }));
      nativeTac=bridge.monitor(onTac, error => eventBus.emit("runtime-warning", { type: "tac-monitor", error: { message: error.message } }));
      offSnapshot = worldModel.events.on("snapshot", async snapshot => {
        nativeTac?.send({ ...snapshot, nativeCombat: executor.nativeState?.combat || {} });const alive=Boolean(snapshot.status?.alive&&snapshot.status?.ready);
        const currentEnvironmentKey = environmentKey(snapshot);
        if (active && !executor.busy && !executor.queueLength && idleEnvironmentKey && currentEnvironmentKey !== idleEnvironmentKey) {
          idleEnvironmentKey = currentEnvironmentKey;
          distribute(false).catch(error => eventBus.emit("runtime-warning", { type: "distribution-dispatch", error: { message: error.message, code: error.code } }));
        }
        if (alive) {
          const rawFlow = estimateEarlySurvivalProgress({ environment: snapshot, nativeState: executor.nativeState });
          if (progressResetPending) { await progressLedger.observe(rawFlow, { death: true }); progressResetPending = false; }
          else await progressLedger.observe(rawFlow);
          const phase = estimateEarlySurvivalProgress({ environment: snapshot, nativeState: executor.nativeState, progressLedger: progressSnapshot() }).currentIndex;
          if (lastStrategicPhase !== null && phase !== lastStrategicPhase) {
            lastStrategicPhase = phase;
            strategy.replan(snapshot, { force: true, distribution: distribution.currentPlan }).catch(error => eventBus.emit("strategic-error", { error }));
          }
        }
        if(alive&&!wasAlive&&(deathEvent||executor.nativeState?.death)&&!tacBusy){tacBusy=true;executor.pause();executor.priority({type:"recover_loot",params:{death:deathEvent||executor.nativeState.death}},"death-recovery").catch(error=>eventBus.emit("runtime-warning",{type:"death-recovery",error:{message:error.message,code:error.code}})).finally(()=>{deathEvent=null;tacBusy=false;executor.resume();});}
        wasAlive=alive;
      });
      reflectionTimer=setInterval(() => reflection.summarize(input()).catch(() => {}), config.intervals.reflectionMs || 180000);
      await strategy.replan(worldModel.latest,{force:true,distribution:null}).catch(e=>eventBus.emit("strategic-error",{error:e}));lastStrategicPhase=estimateEarlySurvivalProgress({environment:worldModel.latest,nativeState:executor.nativeState,progressLedger:progressSnapshot()}).currentIndex;await distribute(false);eventBus.emit("started",{username:config.api.username});
    },
    async stop({ logout = true } = {}) {
      stopped=true;active=false;prefetch.stop();clearInterval(reflectionTimer);clearTimeout(distributionRetryTimer);clearTimeout(queueEmptyTimer);clearTimeout(repairTimer);
      worldModel.stop();nativeTac?.close();executor.pause();executor.cancelPending();
      eventBus.emit("runtime-stop-begin", { at: Date.now() });
      await executor.stop().catch(() => {});
      // The API server owns the game connection. Killing this worker does not
      // disconnect that character. Remove it from the world before any local
      // persistence, and never make shutdown wait on a model reflection.
      try { await client.stop(); } catch {}
      let disconnectError;
      try { await client.disconnect();eventBus.emit("runtime-game-disconnected", { at: Date.now() }); }
      catch (error) { disconnectError=error;eventBus.emit("runtime-warning", { type:"shutdown-disconnect", message:"游戏断连未确认，不能认为角色已经离线", error:{code:error.code,message:error.message} }); }
      if(logout&&!disconnectError) try { await client.logout(); } catch {}
      bridge.close();await prefetch.close();
      await Promise.allSettled([strategy.save(),memory.save(),archive.save(),distribution.persist()]);
      await debugServer?.stop();offIdle();offTacIdle();offFailure();offActionWarning();offWorkareaBlocked();offActionRetry();offAction();offHint();offDeath();offSnapshot?.();offDistributionError();offDistributionSuccess();eventBus.emit("stopped");
      if(disconnectError) throw disconnectError;
    }
  };
}
