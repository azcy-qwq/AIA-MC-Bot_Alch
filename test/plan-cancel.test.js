import test from "node:test";
import assert from "node:assert/strict";
import { ActionExecutor, PlanRunner } from "../src/action/action-executor.js";

test("stopping cancels queued actions and prevents a queued plan from resuming", async () => {
  let finish, calls = 0;
  const executor = new ActionExecutor({ api: { posture: async () => { calls++; await new Promise(resolve => { finish = resolve; }); } } });
  const runner = new PlanRunner({ executor });
  const plan = id => ({ planId: id, tasks: [{ id, title: id, maxAttempts: 2, actions: [{ type: "posture", params: {} }, { type: "posture", params: {} }] }] });
  runner.submit(plan("a")); runner.submit(plan("b"));
  await new Promise(resolve => setImmediate(resolve));
  executor.pause(); executor.cancelPending("stopped"); runner.cancel(); finish();
  await runner.running;
  assert.equal(calls, 1);
  assert.equal(executor.queueLength, 0);
});

test("navigation failure is returned for new observation instead of replaying construction", async () => {
  let calls = 0;
  const executor = { enqueueBatch: async () => { calls++; throw Object.assign(new Error("partial staircase"), { code: "navigation_failed" }); } };
  const results = await new PlanRunner({ executor }).run({ tasks: [{ id: "up", maxAttempts: 5, actions: [{ type: "staircase_up" }] }] });
  assert.equal(calls, 1); assert.equal(results[0].ok, false);
});

test("deterministic placement failure is not replayed", async () => {
  let calls = 0;
  const executor = { enqueueBatch: async () => { calls++; throw Object.assign(new Error("no support"), { code: "no_support" }); } };
  const results = await new PlanRunner({ executor }).run({ tasks: [{ id: "place", maxAttempts: 5, actions: [{ type: "place" }] }] });
  assert.equal(calls, 1); assert.equal(results[0].ok, false);
});
