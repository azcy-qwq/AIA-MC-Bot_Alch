import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NativeBridge } from "../src/native/bridge.js";

test("a bare-handed descent skips an unmineable ore and turns to a supported step", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-stair-no-tool-"));
  let pos = [0.5, 64, 0.5];
  const api = { async request(url, { body = {} } = {}) {
    if (url === "/status") return { ok: true, result: { alive: true, ready: true, health: 6.5, food: 17, pos, dimension: "overworld", is_day: false, on_ground: true } };
    if (url === "/inventory") return { ok: true, result: { items: [], empty_slots: 36 } };
    if (url === "/get_block") {
      const [x, y, z] = body.pos;
      if (x === 1 && y === 63 && z === 0) return { ok: true, result: { name: "copper_ore", diggable: true } };
      if (y < 63) return { ok: true, result: { name: "stone", diggable: true } };
      return { ok: true, result: { name: "air", diggable: true } };
    }
    if (url === "/move_to") { pos = [body.x, body.y, body.z];return { ok: true, result: { pos } }; }
    if (url === "/find_blocks") return { ok: true, result: { blocks: [{ pos: [1, 63, 0], name: "copper_ore" }] } };
    if (url === "/get_entities") return { ok: true, result: { entities: [] } };
    throw new Error(`unexpected ${url}`);
  } };
  const bridge = new NativeBridge({ api, stateFile: path.join(dir, "state.json"), executable: process.env.NATIVE_TEST_EXE });
  try {
    const outcome = await bridge.run("staircase_down", { direction: "x", steps: 1 }).promise;
    assert.deepEqual(outcome.result.pos, [0.5, 63, 1.5]);
    assert.deepEqual(pos, [0.5, 63, 1.5]);
  } finally {
    bridge.close();
    await rm(dir, { recursive: true, force: true });
  }
});
