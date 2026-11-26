import test from "node:test";
import assert from "node:assert/strict";
import { ActionExecutor } from "../src/action/action-executor.js";

test("a strategy dig action continues through visible blocks instead of stopping at one point", async () => {
  const dug = [];
  const api = {
    getBlock: async ({ pos }) => ({ result: { name: "stone", pos } }),
    findBlocks: async () => ({ result: { blocks: [[1, 2, 3], [2, 2, 3], [3, 2, 3]].map(pos => ({ name: "stone", pos })) } }),
    dig: async ({ pos }) => (dug.push(pos), { ok: true })
  };
  const executor = new ActionExecutor({ api });
  const result = await executor.enqueue({ type: "dig", params: { pos: [1, 2, 3], maxBlocks: 3 } }, { source: "action:mine", attempts: 1 });
  assert.equal(result.continuous, true);
  assert.equal(result.dug, 3);
  assert.deepEqual(dug, [[1, 2, 3], [2, 2, 3], [3, 2, 3]]);
});

test("scripts can opt out of continuous mining with single=true", async () => {
  const dug = [];
  const api = { dig: async ({ pos }) => (dug.push(pos), { ok: true }) };
  const executor = new ActionExecutor({ api });
  const result = await executor.enqueue({ type: "dig", params: { pos: [1, 2, 3], single: true } }, { source: "skill:mining", attempts: 1 });
  assert.equal(result.ok, true);
  assert.deepEqual(dug, [[1, 2, 3]]);
});
