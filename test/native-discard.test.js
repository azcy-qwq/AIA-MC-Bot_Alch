import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NativeBridge } from "../src/native/bridge.js";

async function scenario(run, applied = true) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-discard-"));
  const counts = { cobbled_deepslate: 192, stone_axe: 1, raw_iron: 8, bread: 62 };
  const drops = [];
  const api = { async request(url, { body = {} } = {}) {
    if (url === "/status") return { ok: true, result: { alive: true, ready: true, health: 20, dimension: "overworld", pos: [.5, 64, .5] } };
    if (url === "/inventory") return { ok: true, result: { items: Object.entries(counts).map(([name, count]) => ({ name, count })), empty_slots: 8 } };
    if (url === "/drop") { drops.push(body); if (applied) counts[body.item] -= body.count; return { ok: true, result: {} }; }
    throw new Error(`unexpected ${url}`);
  } };
  const bridge = new NativeBridge({ api, executable: process.env.NATIVE_TEST_EXE, stateFile: path.join(dir, "state.json") });
  try { await run(bridge, counts, drops); }
  finally { bridge.close(); await rm(dir, { recursive: true, force: true }); }
}

test("discard confirms surplus rubble removal through actual inventory", async () => {
  await scenario(async (bridge, counts, drops) => {
    const out = await bridge.run("discard_items", { items: [{ item: "cobbled_deepslate", count: 128 }] }).promise;
    assert.equal(counts.cobbled_deepslate, 64);
    assert.deepEqual(drops, [{ item: "cobbled_deepslate", count: 128 }]);
    assert.equal(out.result.items[0].removed, 128);
    assert.equal(counts.raw_iron, 8);
  });
});

test("discard cannot remove an axe, food or iron resources", async () => {
  await scenario(async (bridge, counts, drops) => {
    for (const item of ["stone_axe", "bread", "raw_iron"]) {
      await assert.rejects(bridge.run("discard_items", { items: [{ item, count: 1 }] }).promise, error => error.code === "protected_item");
    }
    assert.deepEqual(drops, []);
    assert.equal(counts.stone_axe, 1);
  });
});

test("discard detects a successful API reply that did not remove the item", async () => {
  await scenario(async bridge => {
    await assert.rejects(bridge.run("discard_items", { items: [{ item: "cobbled_deepslate", count: 64 }] }).promise, error => error.code === "drop_incomplete");
  }, false);
});

test("a protected item in a mixed list is skipped while ordinary rubble is cleared", async () => {
  await scenario(async (bridge, counts, drops) => {
    const out = await bridge.run("discard_items", { items: [{ item: "cobbled_deepslate", count: 128 }, { item: "raw_iron", count: 8 }] }).promise;
    assert.equal(counts.cobbled_deepslate, 64); assert.equal(counts.raw_iron, 8);
    assert.deepEqual(drops, [{ item: "cobbled_deepslate", count: 128 }]);
    assert.equal(out.result.skipped[0].code, "protected_item");
  });
});

test("strict discard checks all counts before any drop, including duplicate requests", async () => {
  await scenario(async (bridge, counts, drops) => {
    for (const items of [[{ item: "cobbled_deepslate", count: 128 }, { item: "cobblestone", count: 1 }], [{ item: "cobbled_deepslate", count: 128 }, { item: "cobbled_deepslate", count: 128 }]]) {
      const out = await bridge.run("discard_items", { items, strict:true }).promise;
      assert.equal(out.result.warning, true); assert.equal(out.result.code, "missing_item");
    }
    assert.deepEqual(drops, []); assert.equal(counts.cobbled_deepslate, 192);
  });
});

test('normal rubble cleanup clamps stale counts without requesting another plan',async()=>{
  await scenario(async(bridge,counts,drops)=>{
    const out=await bridge.run('discard_items',{items:[{item:'cobbled_deepslate',count:256},{item:'cobblestone',count:20}]}).promise;
    assert.equal(out.result.warning,undefined);assert.equal(counts.cobbled_deepslate,0);assert.deepEqual(drops,[{item:'cobbled_deepslate',count:192}]);assert.equal(counts.raw_iron,8);assert.ok(out.result.skipped.every(v=>v.code==='count_clamped'));
  });
});
