import test from "node:test";
import assert from "node:assert/strict";
import { ActionExecutor } from "../src/action/action-executor.js";
import { FishboneMiningScript, VeinMiningScript } from "../src/skills/mining.js";
import { MlgWaterScript } from "../src/skills/mlg-water.js";

test("fishbone mining clears two blocks of headroom per main-tunnel step", async () => {
  const dug = [];
  const api = { getBlock: async ({ pos }) => ({ result: { name: "stone", pos, diggable: true } }), dig: async params => (dug.push(params.pos), { ok: true }) };
  const executor = new ActionExecutor({ api });
  const script = new FishboneMiningScript({ api, executor });
  const result = await script.run({ origin: [0, 10, 0], direction: "z", length: 2, branchLength: 2, branchEvery: 3 });
  assert.equal(result.dug, 4);
  assert.deepEqual(dug, [[0, 10, 0], [0, 11, 0], [0, 10, 1], [0, 11, 1]]);
});

test("vein scan stops at the requested block cap and does not expand forever", async () => {
  let scans = 0;
  const api = { getBlock: async ({ pos }) => (scans += 1, { result: { name: "stone", pos, diggable: true } }) };
  const script = new VeinMiningScript({ api, executor: new ActionExecutor({ api }) });
  const result = await script.run({ types: ["iron_ore"], origin: [0, 0, 0], radius: 3, maxBlocks: 2 });
  assert.equal(result.dug, 0);
  assert.ok(scans <= 65, `unexpected unbounded scan: ${scans}`);
});

test("MLG attempts to use a water bucket on the block below the player", async () => {
  let captured;
  const api = {};
  const worldModel = { latest: { status: { pos: [2.8, 65.2, -4.1] }, inventory: { items: [{ name: "water_bucket", count: 1 }] } } };
  const executor = { enqueue: async (action, options) => (captured = { action, options }, { ok: true }) };
  const script = new MlgWaterScript({ api, worldModel, executor });
  const result = await script.attempt();
  assert.equal(result.attempted, true);
  assert.deepEqual(captured.action, { type: "interact", params: { pos: [2, 64, -5], item: "water_bucket" } });
  assert.equal(captured.options.priority, 100);
});
