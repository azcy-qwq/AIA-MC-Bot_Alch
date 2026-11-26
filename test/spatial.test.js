import test from "node:test";
import assert from "node:assert/strict";
import { SpatialObserver, describeSpace } from "../src/core/spatial-observer.js";
import { preNetherReadiness } from "../src/strategy/pre-nether.js";
import { ActionExecutor } from "../src/action/action-executor.js";

test("unknown cells cannot be interpreted as an exit or a staircase", () => {
  const result = describeSpace({ origin: [0, 64, 0], cells: [] });
  assert.ok(result.columns.every(column => !column.walkable && !column.stairCandidate));
  assert.equal(result.slices[1].rows[2], "??@??");
});

test('shore sand supports walking through cane without becoming a phantom cane step',async()=>{
  const observer=new SpatialObserver({getBlock:async({pos})=>({result:{name:pos[1]<63?'sand':pos[1]<=64?'sugar_cane':'air'}})});
  const result=await observer.observe({pos:[.5,63,.5],dimension:'overworld',ready:true,alive:true});
  assert.ok(result.columns.every(c=>c.walkable&&!c.stepUpWalkable&&!c.stairCandidate));
});

for(const cover of ['leaf_litter','wildflowers','pink_petals'])test(`${cover} is clearance rather than support for a phantom step`,async()=>{
  const observer=new SpatialObserver({getBlock:async({pos})=>({result:{name:pos[1]<64?'grass_block':pos[1]===64?cover:'air'}})});
  const result=await observer.observe({pos:[.5,64,.5],dimension:'overworld',ready:true,alive:true});
  assert.ok(result.columns.every(c=>c.walkable&&!c.stepUpWalkable&&!c.stairCandidate));
});

test("a stair needs support plus three clearable destination cells and own overhead", async () => {
  const api = { getBlock: async ({ pos }) => ({ result: { name: pos[1] <= 64 ? "stone" : "air", diggable: pos[1] <= 64 } }) };
  const observer = new SpatialObserver(api);
  const status = { pos: [0.5, 64, 0.5], dimension: "overworld", ready: true, alive: true };
  const result = await observer.observe(status);
  assert.equal(result.requestedCells, 65);
  assert.ok(result.columns.every(column => !column.walkable && column.stepUpWalkable));
  assert.deepEqual(result.columns[0].stairCandidate.standAt, [0.5, 65, -0.5]);
  assert.equal(observer.current({ ...status, pos: [1.5, 64, 0.5] }), null);
  assert.equal(observer.current({ ...status, dimension: "nether" }), null);
});

test("protected and unknown overhead cells disqualify a stair candidate", async () => {
  const observer = new SpatialObserver({ getBlock: async ({ pos }) => ({ result: { name: pos[0] === 0 && pos[2] === 0 && pos[1] === 66 ? "chest" : pos[1] <= 64 ? "stone" : "air" } }) });
  const result = await observer.observe({ pos: [0.5, 64, 0.5], ready: true, alive: true });
  assert.ok(result.columns.every(column => !column.stairCandidate && !column.stepUpWalkable));
});

test("construction dig remains exact and cannot expand to unrelated stone", async () => {
  const dug = [];
  const executor = new ActionExecutor({ api: { getBlock: async () => ({ result: { name: "stone" } }), dig: async params => (dug.push(params.pos), { ok: true }), findBlocks: async () => { throw new Error("construction must not scan for extra stone"); } } });
  await executor.enqueue({ type: "dig", params: { pos: [1, 65, 0], purpose: "staircase" } }, { source: "action:stair", attempts: 1 });
  assert.deepEqual(dug, [[1, 65, 0]]);
});

test("excavation skips cleared cells but refuses player's support and important blocks", async () => {
  const dug = [];
  const executor = new ActionExecutor({ api: {
    status: async () => ({ result: { pos: [0.5, 64, 0.5] } }),
    getBlock: async ({ pos }) => ({ result: { name: pos[0] === 1 ? "air" : "chest" } }),
    dig: async params => (dug.push(params), { ok: true })
  } });
  const result = await executor.enqueue({ type: "dig", params: { pos: [1, 64, 0] } }, { attempts: 1 });
  assert.equal(result.result.skipped, "already_clear");
  for (const pos of [[0, 63, 0], [2, 64, 0]]) await assert.rejects(executor.enqueue({ type: "dig", params: { pos } }, { attempts: 1 }), error => error.code === "unsafe_excavation");
  assert.equal(dug.length, 0);
});

test("move_to normalizes position arrays and rejects false arrival", async () => {
  let params;
  const executor = new ActionExecutor({ api: { moveTo: async input => (params = input, { result: { pos: [0, 64, 0] } }) } });
  await assert.rejects(executor.enqueue({ type: "move_to", params: { pos: [10, 65, 0] } }, { attempts: 1 }), error => error.code === "navigation_failed");
  assert.deepEqual(params, { x: 10, y: 65, z: 0, range: 0.3 });
});

test("move_to accepts an offset within the requested voxel but rejects an adjacent voxel", async () => {
  const executor = new ActionExecutor({ api: { moveTo: async () => ({ result: { pos: [-143.7, 63, -115.5] } }) } });
  const arrived = await executor.enqueue({ type: "move_to", params: { pos: [-144, 63, -116] } }, { attempts: 1 });
  assert.ok(arrived);
  await assert.rejects(executor.enqueue({ type: "move_to", params: { pos: [-143, 63, -116] } }, { attempts: 1 }), error => error.code === "navigation_failed");
  await assert.rejects(executor.enqueue({ type: "move_to", params: { pos: [-144, 64, -116] } }, { attempts: 1 }), error => error.code === "navigation_failed");
});

test("a move must actually climb the requested block height", async () => {
  const executor = new ActionExecutor({ api: { moveTo: async () => ({ result: { pos: [1.5, 64, 0.5] } }) } });
  await assert.rejects(executor.enqueue({ type: "move_to", params: { pos: [1.5, 65, 0.5] } }, { attempts: 1 }), error => error.code === "navigation_failed");
});

test("navigation skill parameters accept pos without changing terrain tool parameters", async () => {
  const executor = new ActionExecutor({ api: {} });
  executor.lastFailure = { action: "move_to", code: "path_not_found", at: Date.now() };
  let received;
  executor.registerSkillAction("navigation_recover", async params => { received = params; });
  await executor.enqueue({ type: "navigation_recover", params: { pos: [1, 65, 0] } }, { attempts: 1 });
  assert.deepEqual(received.target, [1, 65, 0]);
  assert.equal(received.pos, undefined);
});

test("pre-nether objective reports missing equipment even with huge stockpiles", () => {
  const readiness = preNetherReadiness({ status: { health: 20, food: 20 }, inventory: { items: [{ name: "cobblestone", count: 256 }, { name: "oak_log", count: 400 }, { name: "bread", count: 62 }] } });
  assert.equal(readiness.ready, false);
  assert.equal(readiness.enterNether, false);
  assert.ok(readiness.checks.find(check => check.id === "wood").ok);
  assert.ok(!readiness.checks.find(check => check.id === "armor").ok);
});

test("pre-nether armor and shield must be worn and allow at most one gold piece", () => {
  const pieces = ["iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots"];
  const check = inv => preNetherReadiness({ inventory: inv }).checks;
  assert.equal(check({ items: pieces.map(name => ({ name, count: 1 })) }).find(c => c.id === "armor").ok, false);
  const armor = Object.fromEntries(["head", "chest", "legs", "feet"].map((slot, i) => [slot, { name: pieces[i] }]));
  assert.ok(check({ armor }).find(c => c.id === "armor").ok);
  armor.head.name = "golden_helmet";
  assert.ok(check({ armor }).find(c => c.id === "armor").ok);
  armor.feet.name = "golden_boots";
  assert.equal(check({ armor }).find(c => c.id === "armor").ok, false);
  assert.equal(check({ items: [{ name: "shield", count: 1 }] }).find(c => c.id === "shield").ok, false);
  assert.ok(check({ offhand: { name: "shield" } }).find(c => c.id === "shield").ok);
});
