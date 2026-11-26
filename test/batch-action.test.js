import test from "node:test";
import assert from "node:assert/strict";
import { ActionExecutor } from "../src/action/action-executor.js";
import { EventBus } from "../src/core/events.js";

test("dig_many handles several blocks in one queued tool action and reports progress", async () => {
  const dug = [];
  const progress = [];
  const api = {
    findBlocks: async params => ({ result: { blocks: Array.from({ length: params.limit }, (_, i) => ({ pos: [i, 10, 0] })) } }),
    dig: async params => (dug.push(params.pos), { ok: true })
  };
  const executor = new ActionExecutor({ api });
  executor.events.on("action-progress", event => progress.push(event.progress));
  const result = await executor.enqueue({ type: "dig_many", params: { types: ["oak_log"], limit: 3 } }, { attempts: 1 });
  assert.equal(result.dug, 3);
  assert.deepEqual(dug, [[0, 10, 0], [1, 10, 0], [2, 10, 0]]);
  assert.deepEqual(progress.map(item => item.completed), [1, 2, 3]);
});

test("the plan runner labels model work as Action layer work", async () => {
  const sources = [];
  const executor = { enqueue: async (_action, options) => (sources.push(options.source), { ok: true }) };
  const { PlanRunner } = await import("../src/action/action-executor.js");
  await new PlanRunner({ executor }).run({ tasks: [{ id: "mine", maxAttempts: 1, actions: [{ type: "dig_many", params: {} }] }] });
  assert.deepEqual(sources, ["action:mine"]);
});

test("PlanRunner queues the latest plan while Action is still executing", async () => {
  const order = [];
  let release;
  const executor = { enqueue: async action => { order.push(`start:${action.params.id}`); if (action.params.id === "one") await new Promise(resolve => { release = resolve; }); order.push(`end:${action.params.id}`); return { ok: true }; } };
  const { PlanRunner } = await import("../src/action/action-executor.js");
  const runner = new PlanRunner({ executor });
  runner.submit({ planId: "p1", tasks: [{ id: "one", maxAttempts: 1, actions: [{ type: "dig", params: { id: "one" } }] }] });
  assert.equal(runner.submit({ planId: "p2", tasks: [{ id: "two", maxAttempts: 1, actions: [{ type: "dig", params: { id: "two" } }] }] }), false);
  release();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(order, ["start:one", "end:one", "start:two", "end:two"]);
});

test("navigation construction does not depend on an unrelated previous action", async () => {
  const eventBus = new EventBus();
  const api = { status: async () => ({ result: { pos: [0, 64, 0] } }) };
  const executor = new ActionExecutor({ api, eventBus });
  executor.registerSkillAction("staircase_down", async () => ({ steps: 1 }));
  for (const failure of [null, { action: "equip", code: "missing_item", at: Date.now() }]) {
    executor.lastFailure = failure;
    assert.equal((await executor.enqueue({ type: "staircase_down", params: { direction: "z", steps: 1 } }, { attempts: 1 })).steps, 1);
  }
});
