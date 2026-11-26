import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NativeBridge } from "../src/native/bridge.js";

async function fixture({ stock, input = [], fuel = [], output = [], saved = {}, carried = false }, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mc-smelt-")), stateFile = path.join(directory, "state.json");
  const furnace = [1, 64, 0], puts = [], values = { ...stock };
  let sections = { input, fuel, output }, loaded = false, placed = !carried;
  await writeFile(stateFile, JSON.stringify({ ...saved, workareas: [], anchors: {}, routes: {} }));
  const api = { async request(url, { body = {} } = {}) {
    if (url === "/status") return { ok: true, result: { alive: true, ready: true, pos: [0.5, 64, 0.5], dimension: "overworld", health: 20 } };
    if (url === "/inventory") return { ok: true, result: { items: Object.entries(values).filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })), empty_slots: 20 } };
    if (url === "/find_blocks") return { ok: true, result: { blocks: placed ? [{ pos: furnace, name: "furnace" }] : [] } };
    if (url === "/get_block") return { ok: true, result: { name: placed && body.pos.join(",") === furnace.join(",") ? "furnace" : body.pos[1] < 64 ? "stone" : "air" } };
    if (url === "/place") { assert.deepEqual(body.pos, furnace);assert.equal(values.furnace, 1);values.furnace--;placed = true;return { ok: true, result: {} }; }
    if (url === "/window/view") {
      if (loaded && sections.input.length) {
        const source = sections.input[0];sections.output = [{ name: source.name.endsWith("_log") ? "charcoal" : "iron_ingot", count: source.count }];
        sections.input = [];sections.fuel = [];
      }
      return { ok: true, result: { window: "furnace", sections: structuredClone(sections), info: { burning: false, progress: 0, fuel_left: 0 } } };
    }
    if (url === "/window/act") {
      for (const op of body.ops) {
        if (op.op === "put") {
          assert.ok((values[op.item] || 0) >= op.count);puts.push(op);values[op.item] -= op.count;sections[op.to] = [{ name: op.item, count: op.count }];loaded = true;
        } else {
          const stack = sections[op.from].find(item => item.name === op.item);assert.ok(stack && stack.count >= op.count);
          stack.count -= op.count;values[op.item] = (values[op.item] || 0) + op.count;sections[op.from] = sections[op.from].filter(item => item.count > 0);
          // Let a pre-existing batch finish once its old output is collected.
          if (sections.input.length && sections.fuel.length) loaded = true;
        }
      }
      return { ok: true, result: { done: body.ops } };
    }
    throw new Error(`Unexpected endpoint ${url}`);
  } };
  const bridge = new NativeBridge({ api, stateFile, executable: process.env.NATIVE_TEST_EXE });
  try { await run({ bridge, puts, values }); } finally { bridge.close();await rm(directory, { recursive: true, force: true }); }
}

test("native smelting clears unrelated output and uses logs for the first charcoal", async () => {
  await fixture({ stock: { birch_log: 10 }, output: [{ name: "iron_ingot", count: 2 }] }, async ({ bridge, puts, values }) => {
    const outcome = await bridge.run("workshop", { mode: "smelt", item: "birch_log", count: 4, fuel: "birch_log" }).promise;
    assert.equal(outcome.result.smelted, "charcoal");assert.equal(values.charcoal, 4);assert.equal(values.iron_ingot, 2);assert.equal(values.birch_log, 3);
    assert.deepEqual(puts.map(op => [op.to, op.item, op.count]), [["input", "birch_log", 4], ["fuel", "birch_log", 3]]);
  });
});

test("native smelting resumes loaded ore with no duplicate input or fuel request", async () => {
  await fixture({ stock: { iron_ingot: 3 }, input: [{ name: "raw_iron", count: 3 }], fuel: [{ name: "coal", count: 1 }], output: [{ name: "charcoal", count: 1 }], saved: {
    smeltBatches: { "overworld:[1,64,0]": { input: "raw_iron", requested: 4, targetOutput: 6, complete: false } }
  } }, async ({ bridge, puts, values }) => {
    const outcome = await bridge.run("workshop", { mode: "smelt", item: "raw_iron", count: 4, fuel: "coal" }).promise;
    assert.equal(outcome.result.resumed, true);assert.equal(values.iron_ingot, 6);assert.equal(values.charcoal, 1);assert.deepEqual(puts, []);
  });
});

test("native smelting accepts an output name, places a carried furnace and checks actual inputs", async () => {
  await fixture({ stock: { raw_iron: 3, charcoal: 1, furnace: 1 }, carried: true }, async ({ bridge, puts, values }) => {
    const outcome = await bridge.run("workshop", { mode: "smelt", item: "iron_ingot", count: 3 }).promise;
    assert.equal(outcome.result.smelted, "iron_ingot", JSON.stringify(outcome));
    assert.equal(values.iron_ingot, 3);assert.equal(values.furnace, 0);
    assert.deepEqual(puts.map(op => [op.to, op.item, op.count]), [["input", "raw_iron", 3], ["fuel", "charcoal", 1]]);
  });
});

test("native output-name smelting refuses to load a short batch", async () => {
  await fixture({ stock: { raw_iron: 2, charcoal: 1 } }, async ({ bridge, puts }) => {
    const outcome = await bridge.run("workshop", { mode: "smelt", item: "iron_ingot", count: 3 }).promise;
    assert.equal(outcome.result.code, "missing_ingredients");assert.deepEqual(puts, []);
  });
});

test("native smelting accepts the shared items batch envelope instead of rebuilding a station", async () => {
  await fixture({ stock: { raw_iron: 9, charcoal: 1 } }, async ({ bridge, puts, values }) => {
    const outcome = await bridge.run("workshop", { mode: "smelt", items: [{ item: "raw_iron", count: 3 }], fuel: "charcoal" }).promise;
    assert.equal(outcome.result[0].smelted, "iron_ingot", JSON.stringify(outcome));
    assert.equal(values.iron_ingot, 3);assert.equal(values.raw_iron, 6);
    assert.deepEqual(puts.map(op => [op.to, op.item, op.count]), [["input", "raw_iron", 3], ["fuel", "charcoal", 1]]);
  });
});

test("native output-name smelting resumes a furnace batch without raw ore in inventory", async () => {
  await fixture({ stock: { iron_ingot: 3 }, input: [{ name: "raw_iron", count: 3 }], fuel: [{ name: "coal", count: 1 }], output: [{ name: "charcoal", count: 1 }], saved: {
    smeltBatches: { "overworld:[1,64,0]": { input: "raw_iron", requested: 4, targetOutput: 6, complete: false } }
  } }, async ({ bridge, puts, values }) => {
    const outcome = await bridge.run("workshop", { mode: "smelt", item: "iron_ingot", count: 4, fuel: "coal" }).promise;
    assert.equal(outcome.result.resumed, true);assert.equal(values.iron_ingot, 6);assert.deepEqual(puts, []);
  });
});
