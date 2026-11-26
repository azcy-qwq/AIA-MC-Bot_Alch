import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NativeBridge } from "../src/native/bridge.js";

async function scenario({ side = false, ceiling = 66, landedJump = false, jumpPlaceFails = false, depth = 1, appliedError = false } = {}, run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-mining-floor-"));
  const world = { pos: side ? [2.5, 64-depth, .5] : [1.5, 64-depth, .5], placed: new Set(), dug: new Set(), jumps: 0, moves: [], progress: [] };
  const key = p => p.join(",");
  const api = { async request(url, { body = {} } = {}) {
    if (url === "/status") return { ok: true, result: { alive: true, ready: true, health: 20, dimension: "overworld", pos: world.pos, held: { name: "stone_pickaxe", count: 1 } } };
    if (url === "/inventory") return { ok: true, result: { items: [{ name: "stone_pickaxe", count: 1 }, { name: "cobblestone", count: 64 }], empty_slots: 30 } };
    if (url === "/find_blocks") return { ok: true, result: { blocks: [] } };
    if (url === "/get_block") return { ok: true, result: { name: world.placed.has(key(body.pos)) ? "cobblestone" : world.dug.has(key(body.pos)) ? "air" : body.pos[1] < 64-depth || body.pos[1] >= ceiling || (landedJump || jumpPlaceFails) && body.pos[1] >= 64-depth && body.pos[1] < 64 && body.pos[0] === 0 && body.pos[2] === 0 ? "stone" : "air", diggable: true } };
    if (url === "/equip") return { ok: true, result: {} };
    if (url === "/dig") { world.placed.delete(key(body.pos)); world.dug.add(key(body.pos)); return { ok: true, result: {} }; }
    if (url === "/control") { assert.equal(body.jump, true); world.jumps++; world.jumpFloor = Math.floor(world.pos[1]); if (!landedJump) world.pos[1] += 1.2; return { ok: true, result: {} }; }
    if (url === "/place") {
      if (appliedError && !world.failedPlace) { world.failedPlace = true; world.placed.add(key(body.pos)); world.pos[1] = body.pos[1]+1; return { ok: false, error: { code: "place_failed", message: "delayed error after successful step" } }; }
      if (jumpPlaceFails && !world.failedPlace) { world.failedPlace = true; world.pos[1] = world.jumpFloor; return { ok: false, error: { code: "place_failed", message: "Server refused: still air after landing" } }; }
      assert.notDeepEqual(body.pos, world.pos.map(Math.floor)); world.placed.add(key(body.pos));
      if (!side && !landedJump && !jumpPlaceFails) world.pos[1] = body.pos[1] + 1; return { ok: true, result: {} };
    }
    if (url === "/move_to") { world.pos = [body.x, body.y, body.z]; world.moves.push(world.pos); return { ok: true, result: {} }; }
    throw new Error(`unexpected ${url}`);
  } };
  const bridge = new NativeBridge({ api, executable: process.env.NATIVE_TEST_EXE, stateFile: path.join(dir, "state.json") });
  const lane = { laneId: "floor", dimension: "overworld", origin: [0,64,0], end: [1,64,0], lastPos: [1,64,0], direction: [1,0,0], mainStep: 1, length: 1, branchEvery: 3, branchLength: 1, branchHub: 3, branchSign: 0, branchStep: 0, phase: "main", branches: [] };
  await writeFile(bridge.stateFile, JSON.stringify({ anchors: {}, routes: {}, workareas: [], fishboneRoutes: { "fishbone:floor": lane } }));
  try { await run(bridge, world); } finally { bridge.close(); await rm(dir, { recursive: true, force: true }); }
}

test("resumed mining jumps out of its floor hole with three air cells and preserves the lane", async () => {
  await scenario({}, async (bridge, world) => {
    const out = await bridge.run("fishbone_mine", { laneId: "floor" }, { onProgress: p => world.progress.push(p) }).promise;
    assert.equal(out.result.stopReason, "lane_complete");
    assert.equal(world.jumps, 1); assert.deepEqual([...world.placed], ["1,63,0"]);
    assert.deepEqual(world.pos, [1.5,64,.5]);
    assert.deepEqual(out.state.fishboneRoutes["fishbone:floor"].origin, [0,64,0]);
    assert.ok(world.progress.some(p => p.phase === "mining_floor_restored" && p.method === "pillar"));
  });
});

test("a jump reply received after landing uses a recorded side recess and restores both floors", async () => {
  await scenario({ landedJump: true }, async (bridge, world) => {
    const out = await bridge.run("fishbone_mine", { laneId: "floor" }, { onProgress: p => world.progress.push(p) }).promise;
    assert.equal(out.result.stopReason, "lane_complete"); assert.equal(world.jumps, 1);
    assert.deepEqual([...world.dug], ["0,63,0"]);
    assert.deepEqual([...world.placed], ["1,63,0", "0,63,0"]);
    assert.deepEqual(world.pos, [1.5,64,.5]);
    assert.ok(world.progress.some(p => p.phase === "mining_floor_restored" && p.method === "side_step"));
  });
});

test("landing before jump placement is refused still recovers through the same recorded side recess", async () => {
  await scenario({ jumpPlaceFails: true }, async (bridge, world) => {
    const out = await bridge.run("fishbone_mine", { laneId: "floor" }).promise;
    assert.equal(out.result.stopReason, "lane_complete"); assert.equal(world.failedPlace, true);
    assert.deepEqual([...world.placed], ["1,63,0", "0,63,0"]);
    assert.deepEqual(world.pos, [1.5,64,.5]);
  });
});

test("floor recovery does not jump into a two-cell ceiling", async () => {
  await scenario({ ceiling: 65 }, async (bridge, world) => {
    await assert.rejects(bridge.run("pillar", { height: 1 }).promise, error => error.code === "no_headroom");
    assert.equal(world.jumps, 0); assert.equal(world.placed.size, 0);
  });
});

test("a miner beside the old work point restores its missing floor before walking back", async () => {
  await scenario({ side: true }, async (bridge, world) => {
    const out = await bridge.run("fishbone_mine", { laneId: "floor" }).promise;
    assert.equal(out.result.stopReason, "lane_complete");
    assert.equal(world.jumps, 0); assert.deepEqual([...world.placed], ["1,63,0"]);
    assert.deepEqual(world.pos, [1.5,64,.5]); assert.equal(world.moves.length, 1);
  });
});

test("a two-level mining hole recovers one verified step at a time despite landed jumps", async () => {
  await scenario({ depth: 2, landedJump: true }, async (bridge, world) => {
    const out = await bridge.run("fishbone_mine", { laneId: "floor" }, { onProgress: p => world.progress.push(p) }).promise;
    assert.equal(out.result.stopReason, "lane_complete");
    assert.deepEqual(world.pos, [1.5,64,.5]); assert.equal(world.jumps, 2);
    for (const p of ["1,62,0", "1,63,0", "0,62,0", "0,63,0"]) assert.ok(world.placed.has(p));
    assert.ok(world.progress.some(p => p.phase === "mining_floor_restored" && p.levels === 2));
    assert.equal(out.state.fishboneRoutes["fishbone:floor"].mainStep, 1);
  });
});

test("a delayed placement error after a verified ascent does not restart the completed step", async () => {
  await scenario({ depth: 2, appliedError: true }, async (bridge, world) => {
    const out = await bridge.run("fishbone_mine", { laneId: "floor" }).promise;
    assert.equal(out.result.stopReason, "lane_complete");
    assert.deepEqual(world.pos, [1.5,64,.5]); assert.equal(world.jumps, 2);
    assert.equal(world.dug.size, 0); assert.deepEqual([...world.placed], ["1,62,0","1,63,0"]);
  });
});
