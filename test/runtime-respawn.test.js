import test from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../src/runtime.js";
import { EventBus } from "../src/core/events.js";

test("runtime pauses on death and replans after the API reports respawn", async () => {
  let alive = true;
  let plans = 0;
  const api = {
    login: async () => ({}), connect: async () => ({}), logout: async () => ({}), disconnect: async () => ({}), stop: async () => ({}),
    status: async () => ({ result: { ready: alive, alive, health: alive ? 20 : 0, pos: [0, 64, 0], dimension: "overworld", busy: null } }),
    inventory: async () => ({ result: { items: [], armor: {}, empty_slots: 36 } }),
    getEntities: async () => ({ result: { entities: [] } }),
    findBlocks: async () => ({ result: { scanned: 0, blocks: {} } }),
    events: async () => ({ result: { last_seq: 0, events: [] } }),
    advancements: async () => ({ result: { advancements: [], summary: {} } })
  };
  const eventBus = new EventBus();
  const runtime = createRuntime({
    api,
    eventBus,
    strategyProvider: { createPlan: async () => (plans += 1, { rationale: "test", tasks: [], delegation: [] }) },
    config: { api: { username: "test", password: "test", baseUrl: "http://localhost" }, llm: {}, intervals: { observationMs: 60000, strategyMs: 60000, tacMs: 60000 }, debug: { enabled: false } }
  });
  await runtime.start();
  assert.equal(plans, 1);
  const recovered = new Promise(resolve => eventBus.on("respawned", resolve));
  alive = false;
  runtime.worldModel.events.emit("game-event", { type: "death" });
  assert.equal(runtime.executor.paused, true);
  setTimeout(() => { alive = true; }, 50);
  await recovered;
  assert.equal(runtime.executor.paused, false);
  assert.equal(plans, 2);
  await runtime.stop();
});

test("an aborted initial model request does not shut down the connected runtime", async () => {
  const api = {
    login: async () => ({}), connect: async () => ({}), logout: async () => ({}), disconnect: async () => ({}), stop: async () => ({}),
    status: async () => ({ result: { ready: true, alive: true, health: 20, food: 20, pos: [0, 64, 0], dimension: "overworld", on_ground: true } }),
    inventory: async () => ({ result: { items: [], empty_slots: 36 } }),
    getEntities: async () => ({ result: { entities: [] } }), findBlocks: async () => ({ result: { blocks: {} } }),
    events: async () => ({ result: { events: [] } }), advancements: async () => ({ result: {} })
  };
  const events = new EventBus(), warnings = [];
  events.on("runtime-warning", warning => warnings.push(warning));
  const runtime = createRuntime({ api, eventBus: events,
    strategyProvider: { createPlan: async () => { throw new Error("This operation was aborted"); } },
    config: { api: { username: "test", password: "test" }, llm: {}, intervals: { observationMs: 60000, tacMs: 60000 }, debug: { enabled: false } }
  });
  try {
    await runtime.start();
    assert.ok(warnings.some(warning => warning.type === "initial-planning"));
    assert.ok(runtime.tac.timer);
    assert.equal(runtime.debug.store.snapshot().status, "online");
  } finally { await runtime.stop(); }
});
