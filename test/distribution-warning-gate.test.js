import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../src/core/events.js";
import { NativeDistribution } from "../src/native/distribution.js";

test("repeated warnings allow a repair request and block the failed action and its dependencies", async () => {
  const events = new EventBus();
  let requests = 0;
  const action = { type: "staircase_up", params: { direction: "x", steps: 3 } };
  const task = { id: "surface-exit", title: "出口", goal: "上到地表", actions: [action] };
  const alternate = { type: "staircase_up", params: { direction: "z", steps: 3 } };
  const d = new NativeDistribution({ eventBus: events, provider: { createAutomationPlan: async ({ noThink }) => { requests++; assert.equal(noThink, true); return { tasks: [{ ...task, actions: [requests === 1 ? action : alternate] }] }; } }, memory: { snapshot: () => ({}) }, memoryArchive: { contextSnapshot: () => ({}) }, filePath: null });
  events.emit("action-warning", { action, task, taskId: task.id, warning: { code: "missing_item", message: "缺少搭路方块" } });
  const stable = { status: { dimension: "overworld", pos: [1.5, 64, 2.5] }, inventory: { items: [{ name: "dirt", count: 3 }] } };
  const held = await d.replan(stable, {});
  assert.deepEqual(held.tasks, []);
  events.emit("action-warning", { action, task, taskId: task.id, warning: { code: "missing_item", message: "缺少搭路方块" } });
  assert.equal(d.warningBlocked.code, "missing_item");
  const blocked = await d.replan(stable, { repair: true });
  assert.deepEqual(blocked.tasks, []);
  assert.equal(requests, 1, "a changed position should release the warning gate for reassessment");
  const repaired = await d.replan(stable, { repair: true });
  assert.deepEqual(repaired.tasks[0].actions, [alternate]);
});

test("an ascent material warning does not dispatch a stone-gathering prerequisite", async () => {
  const events = new EventBus();
  const d = new NativeDistribution({ eventBus: events, provider: { createAutomationPlan: async () => ({ tasks: [{ id: "exit", title: "上行", actions: [{ type: "mine_vein", params: { types: ["stone"], targetCount: 16 } }, { type: "staircase_up", params: { direction: "z", steps: 8 } }] }] }) }, memory: { snapshot: () => ({}) }, memoryArchive: { contextSnapshot: () => ({}) }, filePath: null });
  d.lastFailure = { action: { type: "staircase_up", params: { direction: "z", steps: 8 } }, error: { code: "missing_item", message: "缺少搭路方块" }, at: Date.now() };
  d.warningRetryAt = 0;
  const plan = await d.replan({ status: { alive: true, dimension: "overworld", pos: [0.5, 64, 0.5] }, inventory: { items: [] } }, {});
  assert.equal(plan.tasks[0].actions[0].type, "staircase_up");
  assert.equal(plan.tasks[0].actions[0].params.direction, "z");
  assert.ok(!plan.tasks.some(task => task.actions.some(action => action.type === "mine_vein")));
});
