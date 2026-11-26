import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NativeBridge } from "../src/native/bridge.js";

test("food-use timeout is a persisted warning and does not abort the native task", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-food-recovery-"));
  const bridge = new NativeBridge({ api: null, stateFile: path.join(dir, "state.json"), executable: process.env.NATIVE_TEST_EXE });
  let useCalls = 0;
  bridge.api = { async request(url) {
    if (url === "/status") return { ok: true, result: { alive: true, ready: true, health: 20, food: 16, pos: [0.5, 64, 0.5], dimension: "overworld" } };
    if (url === "/inventory") return { ok: true, result: { items: [{ name: "bread", count: 56, slot: 36 }], armor: {}, empty_slots: 30 } };
    if (url === "/use_item") { useCalls++;return { ok: false, error: { code: "timeout", message: "could not finish using bread" } }; }
    throw new Error(`unexpected ${url}`);
  } };
  try {
    const progress = [];
    const first = await bridge.run("maintain", { eat: true }, { onProgress: value => progress.push(value) }).promise;
    assert.equal(first.result.food, 16);
    assert.equal(first.result.eaten, 0);
    assert.equal(useCalls, 1);
    assert.ok(progress.some(value => value.phase === "food_use_deferred" && value.code === "timeout"));
    const saved = JSON.parse(await readFile(bridge.stateFile, "utf8"));
    assert.ok(saved.foodUseCooldownUntil > Date.now());
    await bridge.run("maintain", { eat: true }).promise;
    assert.equal(useCalls, 1, "the next resumed job must honor the cooldown");
  } finally {
    bridge.close();
    await rm(dir, { recursive: true, force: true });
  }
});
