import test from "node:test";
import assert from "node:assert/strict";
import { StrategyMemory } from "../src/strategy/memory.js";
import { EventBus } from "../src/core/events.js";
import { StrategyEngine } from "../src/strategy/strategy-engine.js";
import { MemoryArchive } from "../src/memory/memory-archive.js";

test("Strategy memory records window observations for later planning", async () => {
  const memory = new StrategyMemory();
  await memory.recordAction({ action: { type: "window_view", params: { pos: [1, 64, 2] } }, result: { ok: true, result: { window: "chest", sections: { container: [{ name: "iron_ingot", count: 3 }] } } } });
  const snapshot = memory.snapshot();
  assert.equal(snapshot.facts[0].type, "window_observation");
  assert.equal(snapshot.facts[0].sections.container[0].name, "iron_ingot");
});

test("Strategy context includes memory facts", async () => {
  const memory = new StrategyMemory();
  await memory.recordAction({ action: { type: "window_view", params: { pos: [1, 64, 2] } }, result: { result: { window: "chest", sections: {} } } });
  let context;
  const strategy = new StrategyEngine({ eventBus: new EventBus(), memory, provider: { createPlan: async ({ context: received }) => (context = received, { tasks: [], delegation: [] }) } });
  await strategy.replan({ status: {}, inventory: {}, entities: [], events: [] }, { force: true });
  assert.equal(context.memory.facts[0].type, "window_observation");
});

test("long-term memory archives lessons and window facts for Strategy", async () => {
  const archive = new MemoryArchive();
  await archive.recordFact({ type: "window_observation", key: "window:chest:1", window: "chest", target: { pos: [1, 64, 2] }, sections: { container: [{ name: "iron_ingot", count: 3 }] } });
  await archive.recordReflection({ lessons: ["箱子已查看，优先复用记录"], nextHints: ["不要重复打开同一个箱子"] });
  const snapshot = archive.snapshot();
  assert.ok(snapshot.entries.some(entry => entry.kind === "observation"));
  assert.ok(snapshot.entries.some(entry => entry.kind === "lesson"));
  assert.match(snapshot.entries.find(entry => entry.kind === "observation").summary, /iron_ingot/);
});

test("Strategy keeps the unfinished task when the provider proposes a switch", async () => {
  const eventBus = new EventBus();
  let calls = 0;
  const strategy = new StrategyEngine({ eventBus, provider: { createPlan: async () => {
    calls += 1;
    return calls === 1
      ? { rationale: "收集木头", tasks: [{ id: "wood", title: "收集原木", goal: "获得原木", actions: [{ type: "dig_many", params: { types: ["oak_log"], limit: 3 } }] }] }
      : { rationale: "改去找铁", tasks: [{ id: "iron", title: "寻找铁矿", goal: "获得铁矿", actions: [{ type: "dig_many", params: { types: ["iron_ore"], limit: 3 } }] }] };
  } } });
  const snapshot = { status: { pos: [0, 64, 0], alive: true, ready: true }, inventory: { items: [] }, entities: [], blocks: {}, events: [] };
  const first = await strategy.replan(snapshot, { force: true });
  const second = await strategy.replan(snapshot, { force: true });
  assert.equal(first.tasks[0].id, "wood");
  assert.equal(second.tasks[0].id, "wood");
  assert.equal(second.planId, first.planId);
});

test("Distribution replans when the bot changes position even if risk flags stay the same", async () => {
  const outputs = [
    { tasks: [{ id: "a", title: "短步", goal: "到A", maxAttempts: 1, actions: [{ type: "move_to", params: { pos: [0, 64, 0] } }] }] },
    { tasks: [{ id: "b", title: "新位置", goal: "到B", maxAttempts: 1, actions: [{ type: "move_to", params: { pos: [2, 64, 0] } }] }] }
  ];
  const provider = { createPlan: async () => outputs.shift() };
  const engine = new StrategyEngine({ provider, minReplanMs: 0 });
  const base = { status: { dimension: "overworld", alive: true, ready: true, pos: [0.5, 64, 0.5] }, entities: [], inventory: {} };
  await engine.replan(base, { force: true });
  await engine.replan({ ...base, status: { ...base.status, pos: [1.5, 64, 0.5] } }, { force: true });
  assert.equal(provider.createPlan ? true : false, true);
  assert.equal(engine.currentPlan.tasks[0].id, "b");
});
