import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NativeBridge } from "../src/native/bridge.js";

async function scenario(options, run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-mining-maintenance-"));
  const counts = { stone_pickaxe: 1, iron_pickaxe: 1, cobblestone: 48, cobbled_deepslate: 192, diamond: 2, raw_iron: 5, bread: 62, ...options.counts };
  const world = { pos: [.5, 64, .5], held: "iron_pickaxe", empty: options.empty ?? 0, drops: [], droppedEntities: [], digs: [], looks: [], equips: [], crafts: [], dug: new Set(), progress: [] };
  const key = p => p.join(",");
  const api = { async request(url, { body = {} } = {}) {
    if (url === "/status") return { ok: true, result: { alive: true, ready: true, health: 20, dimension: "overworld", pos: world.pos, yaw: 0, held: { name: world.held, count: 1, slot: 36 } } };
    if (url === "/inventory") return { ok: true, result: { items: Object.entries(counts).filter(([, n]) => n > 0).map(([name, count]) => ({ name, count, ...(name === "iron_pickaxe" ? { durability_used: options.ironUsed ?? 0 } : name === "diamond_pickaxe" ? { durability_used: options.diamondUsed ?? 0 } : {}) })), armor: options.armor || {}, empty_slots: world.empty } };
    if (url === "/get_block") {
      if (options.unloadedBench && key(body.pos) === "-2,64,0") return { ok: false, error: { code: "not_loaded", message: "chunk not loaded" } };
      return { ok: true, result: { name: options.supply && key(body.pos) === "-1,64,0" ? "crafting_table" : world.dug.has(key(body.pos)) || body.pos[2] === 0 && body.pos[0] <= 0 && body.pos[0] >= (options.noDisposal ? 0 : -8) && body.pos[1] >= 64 ? "air" : options.diamond && key(body.pos) === "1,64,0" ? "deepslate_diamond_ore" : "deepslate", diggable: true } };
    }
    if (url === "/find_blocks") return { ok: true, result: { blocks: options.supply && body.types.includes("crafting_table") ? [{ name: "crafting_table", pos: [-1,64,0] }] : [] } };
    if (url === "/craft") {
      world.crafts.push(body);
      if (["redstone_block", "lapis_block"].includes(body.item)) {
        const material = body.item === "redstone_block" ? "redstone" : "lapis_lazuli";
        assert.ok(counts[material] >= body.count * 9);
        counts[material] -= body.count * 9; world.empty = 6;
      }
      if (["stone_pickaxe", "iron_pickaxe", "diamond_pickaxe"].includes(body.item)) {
        const material = body.item === "diamond_pickaxe" ? "diamond" : body.item === "iron_pickaxe" ? "iron_ingot" : counts.cobblestone >= body.count * 3 ? "cobblestone" : "cobbled_deepslate";
        assert.ok(counts[material] >= body.count * 3 && counts.stick >= body.count * 2);
        counts[material] -= body.count * 3; counts.stick -= body.count * 2;
      }
      counts[body.item] = (counts[body.item] || 0) + body.count; return { ok: true, result: {} };
    }
    if (url === "/look") { world.looks.push(body); return { ok: true, result: {} }; }
    if (url === "/drop") { world.drops.push(body); if (options.applyDrop !== false) { counts[body.item] -= body.count; world.empty = 6; world.droppedEntities.push({ ...body, pos: [...world.pos], collected: false }); } return { ok: true, result: {} }; }
    if (url === "/equip") { world.equips.push(body); world.held = body.item; return { ok: true, result: {} }; }
    if (url === "/dig") {
      if (options.autoTool) world.held = "iron_pickaxe";
      if (body.collect) for (const item of world.droppedEntities) if (!item.collected && Math.hypot(...item.pos.map((p, i) => p - body.pos[i])) <= 4) { counts[item.item] += item.count; item.collected = true; world.empty = 0; }
      world.dug.add(key(body.pos)); world.digs.push({ ...body, held: world.held });
      if (options.fillAfterDig && world.digs.length === 1) { world.empty = 0; counts.tuff = 1; }
      return { ok: true, result: { tool: world.held } };
    }
    if (url === "/move_to") { world.pos = [body.x, body.y, body.z]; return { ok: true, result: {} }; }
    throw new Error(`unexpected ${url}`);
  } };
  const bridge = new NativeBridge({ api, executable: process.env.NATIVE_TEST_EXE, stateFile: path.join(dir, "state.json") });
  if (options.unloadedBench) await writeFile(bridge.stateFile, JSON.stringify({ anchors: {}, routes: {}, workareas: [], facilityCache: { "overworld:crafting_table": [-2,64,0] } }));
  if (options.session) await writeFile(path.join(dir, "debug-session.json"), JSON.stringify({ active: true, deadline: Date.now()+60000, goal: "tactical-then-diamond-armor-portal" }));
  try { const out = await bridge.run("fishbone_mine", { laneId: "kept-lane", direction: "x", length: 1 }, { onProgress: p => world.progress.push(p) }).promise; await run(out, world, counts); }
  finally { bridge.close(); await rm(dir, { recursive: true, force: true }); }
}

test("full fishbone inventory frees rubble, retains 64 building blocks and continues the same lane", async () => {
  await scenario({ diamond: true }, (out, world, counts) => {
    assert.equal(out.result.stopReason, "lane_complete");
    assert.equal(out.state.fishboneRoutes["fishbone:kept-lane"].mainStep, 1);
    assert.deepEqual(world.drops, [{ item: "cobbled_deepslate", count: 176 }]);
    assert.equal(counts.cobblestone + counts.cobbled_deepslate, 64);
    assert.equal(counts.diamond, 2); assert.equal(counts.raw_iron, 5); assert.equal(counts.bread, 62);
    assert.ok(world.droppedEntities.every(item => !item.collected));
    assert.equal(world.looks.length, 2);
    assert.equal(world.looks[0].x, -11.5); assert.equal(world.looks[1].yaw, 0);
    assert.deepEqual(world.pos, [1.5, 64, .5]);
    const maintenance = world.progress.find(p => p.phase === "mining_inventory_maintenance");
    assert.deepEqual(maintenance.disposal, [-6, 64, 0]); assert.deepEqual(maintenance.returnTo, [0, 64, 0]);
    assert.ok(world.progress.some(p => p.phase === "mining_inventory_maintenance"));
  });
});

test("a full bag with no surplus rubble stops without dropping protected resources", async () => {
  await scenario({ counts: { cobbled_deepslate: 0, cobblestone: 64 } }, (out, world) => {
    assert.equal(out.result.stopReason, "inventory_full");
    assert.deepEqual(world.drops, []); assert.deepEqual(world.digs, []);
  });
});

test("a full mineral bag packs redstone without discarding ore or changing lanes", async () => {
  await scenario({ supply: true, counts: { redstone: 573, cobbled_deepslate: 0, cobblestone: 64 } }, (out, world, counts) => {
    assert.equal(out.result.stopReason, "lane_complete");
    assert.deepEqual(world.crafts, [{ item: "redstone_block", count: 63 }]);
    assert.equal(counts.redstone + counts.redstone_block * 9, 573);
    assert.deepEqual(world.drops, []);
    assert.equal(out.state.fishboneRoutes["fishbone:kept-lane"].mainStep, 1);
    assert.ok(world.progress.some(p => p.phase === "mining_inventory_compacted"));
  });
});

test("newly full inventory bypasses the eight dig cleanup interval", async () => {
  await scenario({ empty: 1, fillAfterDig: true, counts: { cobbled_deepslate: 0, cobblestone: 64 } }, (out, world) => {
    assert.equal(out.result.stopReason, "lane_complete");
    assert.deepEqual(world.drops, [{ item: "tuff", count: 1 }]);
  });
});

test("an unloaded remembered workbench does not block mineral compaction at a reachable bench", async () => {
  await scenario({ supply: true, unloadedBench: true, counts: { redstone: 573, cobbled_deepslate: 0, cobblestone: 64 } }, (out, world, counts) => {
    assert.equal(out.result.stopReason, "lane_complete");
    assert.deepEqual(world.crafts, [{ item: "redstone_block", count: 63 }]);
    assert.equal(counts.redstone + counts.redstone_block * 9, 573);
  });
});

test("large mineral batches respect the server's 64 recipe round limit", async () => {
  await scenario({ supply: true, counts: { redstone: 585, cobbled_deepslate: 0, cobblestone: 64 } }, (out, world, counts) => {
    assert.equal(out.result.stopReason, "lane_complete");
    assert.deepEqual(world.crafts, [{ item: "redstone_block", count: 64 }]);
    assert.equal(counts.redstone, 9);
    assert.equal(counts.redstone + counts.redstone_block * 9, 585);
  });
});

test("an unapplied automatic drop stops safely without a retry loop", async () => {
  await scenario({ applyDrop: false }, (out, world) => {
    assert.equal(out.result.stopReason, "inventory_full");
    assert.equal(world.drops.length, 1); assert.deepEqual(world.digs, []);
    assert.ok(world.progress.some(p => p.phase === "mining_inventory_warning" && p.code === "drop_incomplete"));
  });
});

test("a full bag without a remote walkable disposal point does not toss at its feet", async () => {
  await scenario({ noDisposal: true }, (out, world) => {
    assert.equal(out.result.stopReason, "inventory_full");
    assert.deepEqual(world.drops, []); assert.deepEqual(world.digs, []);
    assert.ok(world.progress.some(p => p.code === "disposal_site_unavailable"));
  });
});

test("ordinary corridor rock uses stone without pickup pathfinding and diamond still uses iron", async () => {
  await scenario({ empty: 20, diamond: true }, (out, world) => {
    assert.equal(out.result.stopReason, "lane_complete");
    const roof = world.digs.find(d => d.pos[1] === 65);
    const ore = world.digs.find(d => d.pos[1] === 64);
    assert.equal(roof.held, "stone_pickaxe"); assert.equal(roof.collect, false);
    assert.equal(ore.held, "iron_pickaxe"); assert.equal(ore.collect, true);
    assert.equal(world.drops.length, 0);
  });
});

test("an API that overrides the selected tool is detected instead of repeatedly re-equipping", async () => {
  await scenario({ empty: 20, autoTool: true }, (out, world) => {
    assert.equal(out.result.stopReason, "lane_complete");
    assert.equal(out.state.apiBehavior.autoTool, true);
    assert.equal(world.equips.length, 1);
    assert.ok(world.digs.every(d => d.held === "iron_pickaxe"));
    assert.ok(world.progress.some(p => p.phase === "api_tool_override"));
  });
});

test("fishbone locally replenishes stone picks from deepslate and keeps the lane", async () => {
  await scenario({ empty: 12, supply: true, counts: { stone_pickaxe: 0, cobblestone: 0, stick: 4 } }, (out, world, counts) => {
    assert.equal(out.result.stopReason, "lane_complete");
    assert.ok(world.crafts.some(c => c.item === "stone_pickaxe" && c.count === 2));
    assert.equal(counts.stone_pickaxe, 2);
    assert.equal(counts.cobbled_deepslate, 186); assert.equal(counts.stick, 0);
    assert.equal(out.state.fishboneRoutes["fishbone:kept-lane"].mainStep, 1);
    assert.ok(world.progress.some(p => p.phase === "mining_tools_ready"));
  });
});

test("a nearly spent iron pick is replenished locally when ingots are already available", async () => {
  await scenario({ empty: 12, supply: true, ironUsed: 240, counts: { iron_ingot: 3, stick: 2 } }, (out, world, counts) => {
    assert.equal(out.result.stopReason, "lane_complete");
    assert.ok(world.crafts.some(c => c.item === "iron_pickaxe" && c.count === 1));
    assert.equal(counts.iron_pickaxe, 2); assert.equal(counts.iron_ingot, 0);
    assert.equal(out.state.fishboneRoutes["fishbone:kept-lane"].mainStep, 1);
  });
});

test("a supply material shortage warns and continues with the existing iron pick", async () => {
  await scenario({ empty: 12, supply: true, counts: { stone_pickaxe: 0, cobblestone: 0, cobbled_deepslate: 0 } }, (out, world) => {
    assert.equal(out.result.stopReason, "lane_complete");
    assert.deepEqual(world.crafts, []);
    assert.ok(world.progress.some(p => p.phase === "mining_tool_supply_warning" && p.code === "missing_ingredients"));
  });
});

test("a nearly spent diamond pick is replaced locally using three real diamonds", async () => {
  await scenario({ empty: 12, supply: true, diamondUsed: 1428, counts: { diamond_pickaxe: 1, diamond: 11, stick: 2 } }, (out, world, counts) => {
    assert.equal(out.result.stopReason, "lane_complete");
    assert.deepEqual(world.crafts, [{ item: "diamond_pickaxe", count: 1 }]);
    assert.equal(counts.diamond_pickaxe, 2); assert.equal(counts.diamond, 8);
    assert.equal(out.state.fishboneRoutes["fishbone:kept-lane"].mainStep, 1);
  });
});

test("a nearly spent diamond pick without three diamonds does not attempt crafting", async () => {
  await scenario({ empty: 12, supply: true, diamondUsed: 1428, counts: { diamond_pickaxe: 1, diamond: 2, stick: 2 } }, (out, world, counts) => {
    assert.equal(out.result.stopReason, "lane_complete");
    assert.deepEqual(world.crafts, []); assert.equal(counts.diamond, 2);
  });
});

test("a broken diamond pick is replenished before continuing on the same lane", async () => {
  await scenario({ empty: 12, supply: true, counts: { diamond_pickaxe: 0, diamond: 12, stick: 2 } }, (out, world, counts) => {
    assert.equal(out.result.stopReason, "lane_complete");
    assert.deepEqual(world.crafts, [{ item: "diamond_pickaxe", count: 1 }]);
    assert.equal(counts.diamond_pickaxe, 1); assert.equal(counts.diamond, 9);
  });
});

test("diamond session hands off on actual armor materials without completing the lane", async () => {
  await scenario({ session: true, empty: 12, counts: { diamond_pickaxe: 1, diamond: 24 } }, (out, world) => {
    assert.equal(out.result.stopReason, "target_reached");
    assert.equal(out.result.targetReached, false); // The lane itself is unfinished.
    assert.equal(out.state.fishboneRoutes["fishbone:kept-lane"].mainStep, 0);
    assert.deepEqual(world.digs, []); assert.deepEqual(world.crafts, []);
  });
});

test("diamond handoff accounts for worn armor and backpack armor without double counting", async () => {
  await scenario({ session: true, empty: 12, armor: { chest: { name: "diamond_chestplate", count: 1 } }, counts: { diamond_pickaxe: 1, diamond_helmet: 1, diamond: 11 } }, out => {
    assert.equal(out.result.stopReason, "target_reached");
  });
});

test("an unfinished diamond material goal does not interrupt the lane", async () => {
  await scenario({ session: true, empty: 12, counts: { diamond_pickaxe: 1, diamond: 23 } }, out => {
    assert.equal(out.result.stopReason, "lane_complete");
  });
});

test("ordinary fishbone mining keeps running even with 24 diamonds", async () => {
  await scenario({ empty: 12, counts: { diamond_pickaxe: 1, diamond: 24 } }, out => {
    assert.equal(out.result.stopReason, "lane_complete");
  });
});
