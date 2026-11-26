import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NativeBridge } from "../src/native/bridge.js";

async function scenario(noLanding, run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-place-self-"));
  const world = { pos: [0.5, 64, 0.5], calls: 0, placed: false, progress: [] };
  const target = [2, 64, 0];
  const api = { async request(url, { body = {} } = {}) {
    if (url === "/status") return { ok: true, result: { alive: true, ready: true, health: 20, dimension: "overworld", pos: world.pos } };
    if (url === "/inventory") return { ok: true, result: { items: [{ name: "cobblestone", count: 8 }], empty_slots: 35 } };
    if (url === "/get_block") return { ok: true, result: { name: body.pos[1] < 64 || noLanding && body.pos[1] === 64 && body.pos.join() !== target.join() || world.placed && body.pos.join() === target.join() ? "cobblestone" : "air" } };
    if (url === "/place") {
      world.calls++;
      if (world.calls === 1) { world.pos = [2.5,64,.5]; return { ok: false, error: { code: "blocked_by_self", message: "bot is standing in target cell" } }; }
      assert.notDeepEqual(world.pos.map(Math.floor), target);
      assert.ok(Math.hypot(...world.pos.map((v, i) => v - target[i])) < 3.5);
      world.placed = true; return { ok: true, result: {} };
    }
    if (url === "/move_to") { world.pos = [body.x, body.y, body.z]; return { ok: true, result: {} }; }
    throw new Error(`unexpected ${url}`);
  } };
  const bridge = new NativeBridge({ api, executable: process.env.NATIVE_TEST_EXE, stateFile: path.join(dir, "state.json") });
  try { await run(bridge.run("place", { item: "cobblestone", pos: target }, { onProgress: p => world.progress.push(p) }).promise, world); }
  finally { bridge.close(); await rm(dir, { recursive: true, force: true }); }
}

test("server moving into the placement cell recovers at an observed adjacent landing", async () => {
  await scenario(false, async (promise, world) => {
    assert.equal((await promise).result.placed, "cobblestone");
    assert.equal(world.calls, 2); assert.equal(world.placed, true);
    assert.ok(world.progress.some(p => p.phase === "placement_self_recovered"));
  });
});

test("self-blocked placement with no safe adjacent landing stops without retrying", async () => {
  await scenario(true, async (promise, world) => {
    await assert.rejects(promise, e => e.code === "blocked_by_self" && e.details.pos.join() === "2,64,0");
    assert.equal(world.calls, 1); assert.equal(world.placed, false);
  });
});
