import test from "node:test";
import assert from "node:assert/strict";
import { ActionExecutor } from "../src/action/action-executor.js";

test("interacting with a window block falls back to window_view", async () => {
  const calls = [];
  const api = {
    interact: async params => { calls.push(["interact", params]); throw Object.assign(new Error("window required"), { code: "use_window_api" }); },
    windowView: async params => (calls.push(["window_view", params]), { ok: true, result: { window: "chest" } })
  };
  const executor = new ActionExecutor({ api });
  const result = await executor.enqueue({ type: "interact", params: { pos: [1, 64, 2] } }, { source: "action:open-chest", attempts: 1 });
  assert.equal(result.result.window, "chest");
  assert.deepEqual(calls, [["interact", { pos: [1, 64, 2] }], ["window_view", { target: { pos: [1, 64, 2] } }]]);
});

test("window_act rejects empty or malformed operations before the API call", async () => {
  let called = false;
  const executor = new ActionExecutor({ api: { windowAct: async () => { called = true; } } });
  await assert.rejects(executor.enqueue({ type: "window_act", params: { target: { pos: [1, 2, 3] }, ops: [] } }, { attempts: 1 }), error => error.code === "bad_args");
  await assert.rejects(executor.enqueue({ type: "window_act", params: { target: { pos: [1, 2, 3] }, ops: [{ op: "undefined" }] } }, { attempts: 1 }), error => error.code === "bad_args");
  assert.equal(called, false);
});
