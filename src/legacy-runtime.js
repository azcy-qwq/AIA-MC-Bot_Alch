import { Agent } from "../base.js";
import { loadConfig, assertCredentials } from "./config.js";
import { EventBus } from "./core/events.js";
import { WorldModel } from "./core/world-model.js";
import { HeuristicStrategyProvider, OpenAICompatibleProvider } from "./llm/provider.js";
import { StrategyEngine } from "./strategy/strategy-engine.js";
import { StrategicEngine } from "./strategy/strategic-engine.js";
import { ActionExecutor, PlanRunner, LONG_WORK_ACTIONS } from "./action/action-executor.js";
import { STRATEGIC_INTERVAL_MS } from "./strategy/tactical-reference.js";
import { TacController } from "./tac/tac-controller.js";
import { createSkills } from "./skills/index.js";
import { DebugStore } from "./debug/debug-store.js";
import { DebugServer } from "./debug/debug-server.js";
import { ReflectionEngine } from "./reflection/reflection-engine.js";
import { RouteMemory } from "./navigation/route-memory.js";
import { StrategyMemory } from "./strategy/memory.js";
import { MemoryArchive } from "./memory/memory-archive.js";
import { DeathLootRecovery } from "./recovery/death-loot-recovery.js";
import { preNetherReadiness } from "./strategy/pre-nether.js";
import { DISTRIBUTION_LEAD_MS, workRemainingMs } from "./strategy/distribution-timing.js";

export function createRuntime({ config = loadConfig(), api, strategyProvider, eventBus = new EventBus() } = {}) {
  const client = api || new Agent(config.api.username, config.api.password, { baseUrl: config.api.baseUrl });
  const worldModel = new WorldModel(client, { observationIntervalMs: config.intervals.observationMs });
  const executor = new ActionExecutor({ api: client, worldModel, eventBus, retryDelayMs: config.intervals.actionRetryDelayMs ?? 100 });
  const llmProvider = config.llm.baseUrl && config.llm.apiKey && config.llm.model
    ? new OpenAICompatibleProvider({ ...config.llm, onTrace: trace => eventBus.emit("llm-trace", trace), providerName: "distribution" })
    : null;
  const provider = strategyProvider || llmProvider || new HeuristicStrategyProvider();
  const routeMemory = new RouteMemory({ filePath: config.routes?.filePath || null });
  const memory = new StrategyMemory({ filePath: config.memory?.filePath || null });
  const memoryArchive = new MemoryArchive({ filePath: config.memoryArchive?.filePath || null, eventBus });
  const distribution = new StrategyEngine({ provider, eventBus, minReplanMs: config.intervals.strategyMinReplanMs || 5000, routeMemory, memory, memoryArchive });
  const strategy = new StrategicEngine({ provider, eventBus, minReplanMs: STRATEGIC_INTERVAL_MS, routeMemory, memory, memoryArchive, filePath: config.runtimeState?.filePath || null });
  const runner = new PlanRunner({ executor, eventBus });
  const reflection = new ReflectionEngine({ provider: llmProvider || (strategyProvider?.createReflection ? strategyProvider : null), eventBus, minIntervalMs: config.intervals.reflectionMinMs || 90000 });
  const recordMemory = data => Promise.allSettled([memory.recordAction(data), memoryArchive.recordAction(data)]).then(results => {
    for (const result of results) if (result.status === "rejected") eventBus.emit("runtime-warning", { type: "memory-save", error: { message: result.reason?.message || String(result.reason) } });
  });
  const offMemoryEnd = eventBus.on("action-end", data => recordMemory(data));
  const offSpatial = eventBus.on("action-end", ({ action }) => {
    if (["dig", "dig_many", "dig_nearest", "mine_continuous", "place", "staircase_up", "staircase_down", "flatten_area"].includes(action?.type)) worldModel.invalidateSpatial();
  });
  const offMemoryError = eventBus.on("action-error", data => recordMemory(data));
  const offArchiveReflection = eventBus.on("reflection-output", data => memoryArchive.recordReflection(data).catch(error => eventBus.emit("runtime-warning", { type: "memory-save", error: { message: error.message } })));
  const offArchiveHint = eventBus.on("debug-hint", hint => memoryArchive.upsert({ kind: "hint", key: `user:${hint.text}`, summary: hint.text, importance: 1, source: "user", tags: ["user", "hint"] }).catch(error => eventBus.emit("runtime-warning", { type: "memory-save", error: { message: error.message } })));
  const deathLoot = new DeathLootRecovery({ api: client, executor, worldModel, eventBus });
  const skills = createSkills({ api: client, worldModel, executor, routeMemory });
  const tac = new TacController({ api: client, worldModel, executor, eventBus, intervalMs: config.intervals.tacMs, provider: llmProvider || provider, pve: skills.pve });
  executor.registerSkillAction("jump_attack", (params, onProgress, controls) => skills.pve.jumpAttack(params, controls));
  for (const [action, mode] of [["chop_tree", "chop_tree"], ["mine_vein", "mine_vein"], ["fishbone_mine", "fishbone"]]) {
    executor.registerSkillAction(action, (params, onProgress, controls) => skills.work.run({ ...params, mode }, { ...controls, onProgress }));
  }
  executor.registerSkillAction("navigation_recover", (params, onProgress) => skills.navigation.recover({ ...params, onProgress }));
  executor.registerSkillAction("bridge_to", (params, onProgress) => skills.navigation.bridgeTo({ ...params, onProgress }));
  executor.registerSkillAction("ladder_climb", (params, onProgress) => skills.navigation.climbLadder({ ...params, onProgress }));
  executor.registerSkillAction("staircase_down", (params, onProgress) => skills.navigation.staircaseDown({ ...params, preferDirect: true, onProgress }));
  executor.registerSkillAction("staircase_up", (params, onProgress) => skills.navigation.staircaseUp({ ...params, preferDirect: true, onProgress }));
  executor.registerSkillAction("route_navigate", (params, onProgress, controls) => skills.routes.navigate({ ...params, ...controls, onProgress }));
  executor.registerSkillAction("flatten_area", (params, onProgress) => skills.terrain.run({ ...params, onProgress }));
  const debugStore = new DebugStore({ worldModel, eventBus, memoryArchive, executor, runner });
  const debugServer = config.debug.enabled ? new DebugServer({
    store: debugStore,
    host: config.debug.host,
    port: config.debug.port,
    onHint: ({ text }) => ({ ok: true, hint: distribution.addDebugHint(text) }),
    onReflection: () => reflection.summarize(reflectionInput(), { force: true })
  }) : null;
  let strategyTimer;
  let strategicTimer;
  let stopped = false;
  let active = false;
  let recovery = null;
  let strategyTickRunning = false;
  let lastExecutedPlanId = null;
  let reflectionTimer;
  let reflectionDebounce;
  let prefetchedTask = null;
  let actionStartedAt = 0;
  const actionDurations = new Map();
  let lastAliveInventory = null;
  let lastAliveStatus = null;
  let deathEventForRecovery = null;
  const reflectionInput = () => {
    const state = debugStore.snapshot();
    return { events: [...(state.timeline || []), ...(state.toolCalls || []), ...(state.runtimeEvents || [])], hints: distribution.debugHints, currentPlan: distribution.currentPlan, strategicPlan: strategy.currentPlan, memoryArchive: memoryArchive.snapshot() };
  };
  const reflectionTriggers = ["task-complete", "task-error", "action-error", "distribution-error", "strategic-error", "emergency"];
  const offReflection = reflectionTriggers.map(type => eventBus.on(type, () => {
    if (stopped) return;
    clearTimeout(reflectionDebounce);
    reflectionDebounce = setTimeout(() => reflection.summarize(reflectionInput()), config.intervals.reflectionDebounceMs || 18000);
  }));
  const offActionStart = eventBus.on("action-start", ({ startedAt }) => { actionStartedAt = startedAt || Date.now(); });
  const offActionDuration = eventBus.on("action-end", ({ action, durationMs, source }) => {
    if (!source?.startsWith("action:") || !Number.isFinite(durationMs)) return;
    const previous = actionDurations.get(action.type);
    actionDurations.set(action.type, previous === undefined ? durationMs : previous * 0.5 + durationMs * 0.5);
  });
  const offWorkProgress = eventBus.on("action-progress", ({ action, progress }) => {
    if (!LONG_WORK_ACTIONS.has(action?.type) || progress?.phase === "finished") return;
    strategyTick().catch(error => eventBus.emit("error", error));
  });
  const offTaskFinished = ["task-complete", "task-error"].map(type => eventBus.on(type, data => {
    if (type === "task-error" && !data.final) return;
    setTimeout(() => { if (active && !stopped && !recovery && !tac.engaged) strategyTick({ force: true }).catch(error => eventBus.emit("error", error)); }, 100);
  }));
  const offEmergency = eventBus.on("emergency", () => runner.cancel());
  const offTacIdle = eventBus.on("tac-idle", () => {
    setTimeout(() => { if (active && !stopped && !recovery) strategyTick({ force: true }).catch(error => eventBus.emit("error", error)); }, 100);
  });
  const offWorldEvents = worldModel.events.on("game-event", event => {
    if (event.type === "death") {
      deathEventForRecovery = event;
      recoverAfterDeath(event);
    }
  });
  const offSnapshots = worldModel.events.on("snapshot", snapshot => {
    if (config.mission?.preNether) snapshot.mission = preNetherReadiness(snapshot);
    if (snapshot.status?.alive) {
      lastAliveInventory = snapshot.inventory;
      lastAliveStatus = snapshot.status;
    }
    if (active && snapshot.status && !snapshot.status.alive) recoverAfterDeath(deathEventForRecovery || { type: "death", pos: snapshot.status.last_death?.pos, cause: snapshot.status.last_death?.cause });
  });

  async function waitUntilReady(timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const status = (await client.status()).result;
        if (status?.ready && status.alive) return status;
      } catch (error) {
        eventBus.emit("runtime-warning", { type: "status-poll", error: { message: error.message, code: error.code, status: error.status, details: error.details } });
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    throw new Error("Timed out waiting for the bot to become ready");
  }

  async function strategyTick({ force = false } = {}) {
    if (stopped || (recovery && !force) || strategyTickRunning) return;
    if (tac.engaged) return;
    const taskKey = runner.activeTask && `${runner.activePlanId}:${runner.activeTask.id}`;
    const taskSource = runner.activeTask && `action:${runner.activeTask.id}`;
    const busy = Boolean(runner.running || executor.busy || executor.queueLength);
    let nextTask = false;
    if (busy) {
      // All entry points, including forced completion/Tac callbacks, obey the
      // same gate. Never overwrite an already prepared next plan.
      if (!taskKey || taskKey === prefetchedTask || runner.queuedPlan || runner.pendingRevision) return;
      if (executor.running?.source !== taskSource || executor.queue.some(item => item.source === taskSource)) return;
      const remainingMs = executor.workProgress ? workRemainingMs(executor.workProgress)
        : actionDurations.has(executor.currentAction?.type) ? Math.max(0, actionDurations.get(executor.currentAction.type) - (Date.now() - actionStartedAt)) : null;
      if (remainingMs === null || remainingMs > DISTRIBUTION_LEAD_MS) return;
      prefetchedTask = taskKey;
      nextTask = true;
      force = true;
    } else if (!force && Date.now() - distribution.lastRunAt < distribution.minReplanMs) return;
    strategyTickRunning = true;
    try {
      const snapshot = await worldModel.refresh();
      await worldModel.refreshSpatial();
      if (config.mission?.preNether) snapshot.mission = preNetherReadiness(snapshot);
      if (!snapshot.status?.ready || !snapshot.status.alive) {
        recoverAfterDeath();
        return;
      }
      if (snapshot.mission?.ready) {
        eventBus.emit("mission-ready", { message: "下界前准备清单已满足，保持在主世界等待用户", readiness: snapshot.mission });
        return;
      }
      strategy.debugHints = distribution.debugHints;
      const thinking = strategy.replan(snapshot, { distribution: distribution.currentPlan });
      thinking.catch(error => eventBus.emit("runtime-warning", { type: "strategic-background", error: { message: error.message } }));
      const strategicPlan = strategy.currentPlan || await thinking;
      const plan = await distribution.replan(snapshot, { force, nextTask, execution: { ...runner.snapshot(), autonomousWork: executor.workProgress }, strategicPlan });
      if (stopped || !active || recovery || tac.engaged) return;
      if (plan && plan.planId !== lastExecutedPlanId) {
        lastExecutedPlanId = plan.planId;
        runner.submit(plan);
      }
    } finally {
      strategyTickRunning = false;
    }
  }

  async function recoverAfterDeath(deathEvent = null) {
    if (stopped || recovery) return recovery;
    const recoveryEvent = deathEvent || deathEventForRecovery;
    const previousInventory = lastAliveInventory;
    const previousStatus = lastAliveStatus;
    recovery = (async () => {
      let recovered = false;
      distribution.currentPlan = null;
      executor.pause();
      executor.cancelPending("Bot died; waiting for respawn");
      runner.cancel();
      try { await executor.stop(); } catch {}
      eventBus.emit("respawn-waiting", { message: "Bot is dead; waiting for the server to respawn it" });
      try {
        const status = await waitUntilReady(360000);
        await worldModel.refresh({ force: true });
        await worldModel.refreshSpatial();
        // Recovery is best effort; a respawn next to hostiles must first
        // establish safety instead of sending an empty inventory back to the
        // death point or replaying stale food actions.
        recovered = true;
        runner.cancel();
        executor.resume();
        try {
          await deathLoot.recover({ deathEvent: recoveryEvent, previousInventory, previousStatus });
        } catch (error) {
          eventBus.emit("runtime-warning", { type: "death-loot-recovery", error: { message: error.message, code: error.code } });
        }
        runner.cancel();
        await strategyTick({ force: true });
        executor.resume();
        recovery = null;
        eventBus.emit("respawned", { status });
        return status;
      } finally {
        if (stopped || recovered) executor.resume();
        recovery = null;
      }
    })().catch(error => {
      eventBus.emit("runtime-warning", { type: "respawn-wait", error: { message: error.message, code: error.code } });
      recovery = null;
      return null;
    });
    return recovery;
  }

  return {
    api: client, worldModel, executor, strategy, distribution, runner, tac, skills, reflection, memory, memoryArchive, deathLoot, debug: { store: debugStore, server: debugServer }, events: eventBus,
    async start({ requireCredentials = true } = {}) {
      if (debugServer) {
        try { const address = await debugServer.start(); console.log(`[debug-ui] ${address}`); }
        catch (error) { eventBus.emit("error", error); }
      }
      if (requireCredentials) assertCredentials(config);
      await routeMemory.load();
      await memory.load();
      await memoryArchive.load();
      await strategy.load();
      await memoryArchive.importFacts(memory.facts);
      if (memoryArchive.latestSummary) {
        Object.assign(reflection, {
          document: memoryArchive.latestSummary.document,
          lessons: memoryArchive.latestSummary.lessons,
          nextHints: memoryArchive.latestSummary.nextHints
        });
        debugStore.state.reflection = memoryArchive.latestSummary;
      }
      await client.login();
      await client.connect();
      await waitUntilReady();
      active = true;
      await worldModel.refresh();
      worldModel.start();
      tac.start();
      // A failed first model request must not tear down a connected worker.
      // The normal planning timer retries while Tac and observation stay up.
      await strategyTick().catch(error => eventBus.emit("runtime-warning", { type: "initial-planning", error: { message: error.message, code: error.code } }));
      // A lightweight local check opens the 4-second window; it does not make
      // model requests while the current task is still far from completion.
      strategyTimer = setInterval(() => strategyTick().catch(error => eventBus.emit("error", error)), 250);
      strategicTimer = setInterval(() => {
        strategy.debugHints = distribution.debugHints;
        strategy.replan(worldModel.latest, { distribution: distribution.currentPlan }).catch(error => eventBus.emit("error", error));
      }, STRATEGIC_INTERVAL_MS);
      reflectionTimer = setInterval(() => reflection.summarize(reflectionInput()).catch(() => {}), config.intervals.reflectionMs || 180000);
      eventBus.emit("started", { username: config.api.username });
    },
    async stop({ logout = true } = {}) {
      stopped = true;
      active = false;
      executor.pause();
      executor.cancelPending("Agent stopped");
      runner.cancel();
      if (strategyTimer) clearInterval(strategyTimer);
      if (strategicTimer) clearInterval(strategicTimer);
      if (reflectionTimer) clearInterval(reflectionTimer);
      clearTimeout(reflectionDebounce);
      await Promise.allSettled([strategy.save(), memory.save(), memoryArchive.save()]);
      tac.stop();
      worldModel.stop();
      try { await client.stop(); } catch {}
      try { await client.disconnect(); } catch {}
      if (logout) try { await client.logout(); } catch {}
      await debugServer?.stop();
      offWorldEvents();
      offSnapshots();
      offReflection.forEach(unsubscribe => unsubscribe());
      offActionStart();
      offActionDuration();
      offWorkProgress();
      offTaskFinished.forEach(off => off());
      offEmergency();
      offTacIdle();
      offMemoryEnd();
      offSpatial();
      offMemoryError();
      offArchiveReflection();
      offArchiveHint();
      eventBus.emit("stopped");
    },
    recover: recoverAfterDeath
  };
}
