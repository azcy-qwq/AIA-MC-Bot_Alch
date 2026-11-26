import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NativeBridge } from "../src/native/bridge.js";

async function fixture(api, run, saved) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-tree-equip-"));
  const bridge = new NativeBridge({ api, stateFile: path.join(dir, "state.json"), executable: process.env.NATIVE_TEST_EXE });
  if (saved) await writeFile(bridge.stateFile, JSON.stringify(saved));
  try { await run(bridge); } finally { bridge.close();await rm(dir, { recursive: true, force: true }); }
}

test("short construction movement crosses the cell boundary despite the API's half-block early return",async()=>{
  let pos=[-87.3,-35,-252.5],moves=0;
  await fixture({async request(url,{body={}}={}){
    if(url==="/status")return {ok:true,result:{alive:true,ready:true,pos,dimension:"overworld"}};
    if(url==="/get_block")return {ok:true,result:{name:body.pos[1]<-35?"deepslate":"air"}};
    if(url==="/move_to"){
      moves++;assert.equal(body.range,0);
      if(Math.hypot(pos[0]-body.x,pos[1]-body.y,pos[2]-body.z)>body.range+.5)pos=[body.x,body.y,body.z];
      return {ok:true,result:{pos}};
    }
    throw new Error(`unexpected ${url}`);
  }},async bridge=>{
    await bridge.run("move_to",{target:[-87,-35,-253]}).promise;
    assert.deepEqual(pos,[-86.5,-35,-252.5]);assert.equal(moves,1);
  });
});

test("a diagonal segment is measured from the center of the current cell", async () => {
  let pos = [0.5, 64, 0.5], moves = 0;
  await fixture({ async request(url, { body = {} } = {}) {
    if (url === "/status") return { ok: true, result: { alive: true, ready: true, pos, dimension: "overworld" } };
    if (url === "/get_block") return { ok: true, result: { name: body.pos[1] < 64 ? "stone" : "air" } };
    if (url === "/move_to") {
      assert.ok(Math.hypot(body.x - pos[0], body.y - pos[1], body.z - pos[2]) <= 10);
      moves++;
      pos = [body.x, body.y, body.z];
      return { ok: true, result: { pos } };
    }
    throw new Error(`unexpected ${url}`);
  } }, async bridge => {
    await bridge.run("move_to", { target: [9, 64, 3] }).promise;
    assert.deepEqual(pos, [9.5, 64, 3.5]);
    assert.equal(moves, 1);
  });
});

test("workstation placement moves out of the player's head and subsequent storage uses its actual position", async () => {
  let chest=null,stored=0,placed=0;const preferred=[0,65,0];
  await fixture({async request(url,{body={}}={}){
    if(url==="/status")return {ok:true,result:{alive:true,ready:true,pos:[.5,64,.5],dimension:"overworld"}};
    if(url==="/inventory")return {ok:true,result:{items:[{name:"chest",count:chest?0:1},{name:"stone_pickaxe",count:3-stored}],empty_slots:3}};
    if(url==="/get_block")return {ok:true,result:{name:chest&&body.pos.join(",")===chest.join(",")?"chest":body.pos[1]<64?"stone":"air"}};
    if(url==="/place"){assert.notDeepEqual(body.pos,[0,64,0]);assert.notDeepEqual(body.pos,preferred);chest=body.pos;placed++;return {ok:true,result:{}};}
    if(url==="/window/view") {assert.deepEqual(body.target.pos,chest);return {ok:true,result:{sections:{container:[]}}};}
    if(url==="/window/act"){assert.deepEqual(body.target.pos,chest);assert.equal(body.ops[0].count,2);stored=2;return {ok:true,result:{}};}
    throw new Error(`unexpected ${url}`);
  }},async bridge=>{
    const result=await bridge.run("place",{item:"chest",pos:preferred}).promise;
    assert.deepEqual(result.result.pos,chest);
    await bridge.run("workshop",{mode:"store",target:preferred,items:[{item:"stone_pickaxe",count:2}]}).promise;
    await bridge.run("place",{item:"chest",pos:preferred}).promise;
    assert.equal(placed,1);assert.equal(stored,2);
  });
});

test("repeated equip recognizes worn armor without requiring a second inventory item", async () => {
  const calls = [];
  await fixture({ async request(url) {
    calls.push(url);
    if (url === "/status") return { ok: true, result: { alive: true, ready: true, pos: [0.5, 64, 0.5], dimension: "overworld" } };
    if (url === "/inventory") return { ok: true, result: { items: [], armor: { legs: { name: "iron_leggings", count: 1, slot: 7 } } } };
    throw new Error(`unexpected ${url}`);
  } }, async bridge => {
    const outcome = await bridge.run("equip", { item: "iron_leggings", slot: "legs" }).promise;
    assert.equal(outcome.result.equipped, "iron_leggings");
    assert.ok(!calls.includes("/equip"));
  });
});

test("armor equip verifies the destination instead of trusting API success", async () => {
  let calls = 0;
  await fixture({ async request(url) {
    if (url === "/status") return { ok: true, result: { alive: true, ready: true, pos: [0.5, 64, 0.5], dimension: "overworld" } };
    if (url === "/inventory") return { ok: true, result: { items: [{ name: "iron_chestplate", count: 1 }], armor: { chest: null } } };
    if (url === "/equip") { calls++;return { ok: true, result: {} }; }
    throw new Error(`unexpected ${url}`);
  } }, async bridge => {
    await assert.rejects(bridge.run("equip", { item: "iron_chestplate", slot: "torso" }).promise, { code: "equip_not_applied" });
    assert.equal(calls, 1);
  });
});

test("workshop total target includes worn armor and avoids crafting duplicates", async () => {
  await fixture({ async request(url) {
    if (url === "/inventory") return { ok: true, result: { items: [], armor: { chest: { name: "iron_chestplate", count: 1, slot: 6 } } } };
    throw new Error(`unnecessary request ${url}`);
  } }, async bridge => {
    const outcome = await bridge.run("workshop", { mode: "craft", items: [{ item: "iron_chestplate", count: 1, total: true }] }).promise;
    assert.deepEqual(outcome.result, []);
  });
});

test("workshop fills a partial output stack instead of subtracting existing items twice", async () => {
  const stock = { torch: 26, stick: 2, coal: 2 };const calls = [];
  await fixture({ async request(url, { body = {} } = {}) {
    if (url === "/inventory") return { ok: true, result: { items: Object.entries(stock).map(([name, count]) => ({ name, count })) } };
    if (url === "/craft") { assert.equal(body.item, "torch");assert.equal(body.count, 6);calls.push(body);stock.torch += 8;stock.stick -= 2;stock.coal -= 2;return { ok: true, result: {} }; }
    throw new Error(`unexpected ${url}`);
  } }, async bridge => {
    await bridge.run("workshop", { mode: "craft", items: [{ item: "torch", count: 32, total: true }] }).promise;
    assert.equal(calls.length, 1);assert.equal(stock.torch, 34);
  });
});

test("batch stick recipe uses abundant birch rather than multiplying one stray spruce plank", async () => {
  const stock = { birch_planks: 67, spruce_planks: 1, stick: 0 };let crafted = false;
  await fixture({ async request(url, { body = {} } = {}) {
    if (url === "/inventory") return { ok: true, result: { items: Object.entries(stock).map(([name, count]) => ({ name, count })) } };
    if (url === "/craft") { assert.equal(body.item, "stick");assert.equal(body.count, 16);stock.birch_planks-=8;stock.stick+=16;crafted=true;return { ok: true, result: {} }; }
    throw new Error(`unexpected ${url}`);
  } }, async bridge => {
    const outcome = await bridge.run("craft", { item: "stick", count: 16 }).promise;
    assert.equal(crafted, true);assert.equal(stock.spruce_planks, 1);
    assert.deepEqual(outcome.result.preflight.missing, []);
  });
});

test("mixed small plank stacks together satisfy the complete batch requirement", async () => {
  let inv = { items: [{ name: "birch_planks", count: 3 }, { name: "spruce_planks", count: 1 }] };
  await fixture({ async request(url, { body = {} } = {}) {
    if (url === "/inventory") return { ok: true, result: inv };
    if (url === "/craft") { assert.equal(body.item, "stick");assert.equal(body.count, 8);inv={ items: [{ name: "stick", count: 8 }] };return { ok: true, result: {} }; }
    throw new Error(`unexpected ${url}`);
  } }, async bridge => {
    await bridge.run("craft", { item: "stick", count: 8 }).promise;
  });
});

test("missing planks are produced from available birch logs before crafting sticks", async () => {
  const stock = { birch_log: 2, stick: 0, birch_planks: 0 };const crafts=[];
  await fixture({ async request(url, { body = {} } = {}) {
    if (url === "/inventory") return { ok: true, result: { items: Object.entries(stock).map(([name, count]) => ({ name, count })) } };
    if (url === "/craft") { crafts.push(body.item);if(body.item === "birch_planks"){stock.birch_log--;stock.birch_planks+=4;}else{assert.equal(body.item,"stick");stock.birch_planks-=2;stock.stick+=4;}return { ok: true, result: {} }; }
    throw new Error(`unexpected ${url}`);
  } }, async bridge => {
    await bridge.run("craft", { item: "stick", count: 4 }).promise;
    assert.deepEqual(crafts,["birch_planks","stick"]);
  });
});

test("local ore mining preserves a nearly broken iron pick by selecting a healthy stone pick", async () => {
  let held="iron_pickaxe", ore=true, raw=0;const equips=[];
  await fixture({ async request(url, { body = {} } = {}) {
    if(url === "/status")return {ok:true,result:{alive:true,ready:true,health:20,pos:[.5,64,.5],dimension:"overworld",held:{name:held,count:1,slot:36}}};
    if(url === "/inventory")return {ok:true,result:{items:[{name:"iron_pickaxe",count:1,durability_used:248,slot:36},{name:"stone_pickaxe",count:1,durability_used:44,slot:37},{name:"raw_iron",count:raw}],empty_slots:30}};
    if(url === "/find_blocks")return {ok:true,result:{blocks:ore?[{pos:[1,64,0],name:"iron_ore"}]:[]}};
    if(url === "/get_block")return {ok:true,result:{name:ore&&body.pos.join(",")==="1,64,0"?"iron_ore":body.pos[1]<64?"stone":"air"}};
    if(url === "/equip"){held=body.item;equips.push(body.item);return {ok:true,result:{}};}
    if(url === "/dig"){assert.equal(held,"stone_pickaxe");ore=false;raw++;return {ok:true,result:{}};}
    throw new Error(`unexpected ${url}`);
  } },async bridge=>{await bridge.run("mine_vein",{types:["iron_ore"],targetCount:1}).promise;assert.deepEqual(equips,["stone_pickaxe"]);});
});

test("tree harvest finishes the connected six-log birch after reaching the inventory target", async () => {
  const logs = new Map(Array.from({ length: 6 }, (_, i) => [[1, 64 + i, 0].join(","), [1, 64 + i, 0]]));
  let wood = 0, scans = 0;const digs = [];
  await fixture({ async request(url, { body = {} } = {}) {
    if (url === "/status") return { ok: true, result: { alive: true, ready: true, health: 20, pos: [0.5, 64, 0.5], dimension: "overworld", held: { name: "stone_axe", count: 1, slot: 36 } } };
    if (url === "/inventory") return { ok: true, result: { items: [{ name: "stone_axe", count: 1, slot: 36 }, { name: "birch_log", count: wood, slot: 10 }], empty_slots: 34 } };
    if (url === "/get_entities") return { ok: true, result: { entities: [] } };
    if (url === "/find_blocks") { scans++;return { ok: true, result: { blocks: [...logs.values()].map(pos => ({ pos, name: "birch_log" })) } }; }
    if (url === "/get_block") return { ok: true, result: { name: logs.has(body.pos.join(",")) ? "birch_log" : body.pos[1] < 64 ? "dirt" : "air", diggable: true } };
    if (url === "/dig") { assert.ok(logs.delete(body.pos.join(",")));wood++;digs.push(body.pos);return { ok: true, result: {} }; }
    throw new Error(`unexpected ${url}`);
  } }, async bridge => {
    const outcome = await bridge.run("chop_tree", { targetCount: 1 }).promise;
    assert.equal(outcome.result.mined, 6);
    assert.equal(outcome.result.treesCompleted, 1);
    assert.equal(outcome.result.incompleteTrees, 0);
    assert.equal(logs.size, 0);
    assert.equal(digs[0][1], 69);
    assert.ok(scans < digs.length, `${scans} scans for ${digs.length} logs`);
  });
});

async function workshopFixture(failSecond, run) {
  const stock = { crafting_table: 1, stick: 4, cobblestone: 6 }, events = [];
  let bench;
  await fixture({ async request(url, { body = {} } = {}) {
    if (url === "/status") return { ok: true, result: { alive: true, ready: true, health: 20, pos: [0.5, 64, 0.5], dimension: "overworld" } };
    if (url === "/inventory") return { ok: true, result: { items: Object.entries(stock).filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })), empty_slots: 30 } };
    if (url === "/find_blocks") return { ok: true, result: { blocks: bench ? [{ pos: bench, name: "crafting_table" }] : [] } };
    if (url === "/get_block") return { ok: true, result: { name: bench && JSON.stringify(body.pos) === JSON.stringify(bench) ? "crafting_table" : body.pos[1] < 64 ? "stone" : "air" } };
    if (url === "/place") { bench = body.pos;stock.crafting_table--;events.push("place");return { ok: true, result: {} }; }
    if (url === "/craft") {
      assert.ok(bench, "craft station must remain in place");events.push(`craft:${body.item}`);
      if (failSecond && body.item === "stone_pickaxe") return { ok: false, error: { code: "api_error", message: "simulated crafting failure" } };
      stock.stick -= 2;stock.cobblestone -= 3;stock[body.item] = 1;return { ok: true, result: {} };
    }
    if (url === "/dig") { events.push("dig");bench = null;stock.crafting_table++;return { ok: true, result: {} }; }
    throw new Error(`unexpected ${url}`);
  } }, async bridge => run({ bridge, events, stock, hasBench: () => Boolean(bench) }));
}

const workshopJob = { mode: "craft", items: [{ item: "stone_axe", count: 1, total: true }, { item: "stone_pickaxe", count: 1, total: true }] };

test("high tree is harvested by climbing a recorded pillar then dismantling it to the ground", async () => {
  const logs = new Map(Array.from({ length: 12 }, (_, i) => [[1, 64 + i, 0].join(","), [1, 64 + i, 0]]));
  const tower = new Map(), events = [];let pos = [0.5, 64, 0.5], wood = 0, held = "stone_axe";
  await fixture({ async request(url, { body = {} } = {}) {
    const key = body.pos?.join(",");
    if (url === "/status") return { ok: true, result: { alive: true, ready: true, health: 20, pos, dimension: "overworld", on_ground: true, held: { name: held, count: 1, slot: 36 } } };
    if (url === "/inventory") return { ok: true, result: { items: [{ name: "stone_axe", count: 1, slot: 36 }, { name: "stone_pickaxe", count: 1, slot: 37 }, { name: "dirt", count: 32 }, { name: "birch_log", count: wood }], empty_slots: 30 } };
    if (url === "/get_block") return { ok: true, result: { name: logs.has(key) ? "birch_log" : tower.get(key) || (body.pos[1] < 64 ? "dirt" : "air"), diggable: true } };
    if (url === "/find_blocks") return { ok: true, result: { blocks: [...logs.values()].map(pos => ({ pos, name: "birch_log" })) } };
    if (url === "/get_entities") { assert.equal(pos[1], 64, "pickup must wait until ground return");return { ok: true, result: { entities: [] } }; }
    if (url === "/move_to") { assert.equal(pos[1], 64, "do not navigate away from a high pillar");pos = [body.x, body.y, body.z];return { ok: true, result: {} }; }
    if (url === "/control") { if (body.jump) pos = [pos[0], pos[1] + 1, pos[2]];return { ok: true, result: {} }; }
    if (url === "/equip") { held = body.item;return { ok: true, result: {} }; }
    if (url === "/place") { tower.set(key, body.item);events.push(["up", body.pos[1]]);return { ok: true, result: {} }; }
    if (url === "/dig") {
      assert.ok(Math.hypot(body.pos[0] + .5 - pos[0], body.pos[1] + .5 - pos[1] - 1.62, body.pos[2] + .5 - pos[2]) <= 4.2);
      if (logs.delete(key)) wood++;
      else { assert.equal(body.collect, false);assert.ok(tower.delete(key), "only dismantle recorded placed blocks");assert.ok(body.pos[1] >= 64);pos = [pos[0], pos[1] - 1, pos[2]];events.push(["down", body.pos[1]]); }
      return { ok: true, result: {} };
    }
    throw new Error(`unexpected ${url}`);
  } }, async bridge => {
    const outcome = await bridge.run("chop_tree", { targetCount: 1 }).promise;
    assert.equal(outcome.result.mined, 12);assert.equal(logs.size, 0);assert.equal(tower.size, 0);
    assert.equal(pos[1], 64);assert.ok(events.some(([phase]) => phase === "up"));
    assert.deepEqual(events.filter(([p]) => p === "down").map(([, y]) => y), events.filter(([p]) => p === "up").map(([, y]) => y).reverse());
    assert.equal(outcome.state.treePillar.active, false);
  });
});

test("ordinary work first recovers a pillar whose last placement response was lost", async () => {
  let pos = [0.5, 66, 0.5];const tower = new Set(["0,64,0", "0,65,0"]), digs = [];
  await fixture({ async request(url, { body = {} } = {}) {
    if (url === "/status") return { ok: true, result: { alive: true, ready: true, pos, dimension: "overworld", held: { name: "stone_pickaxe", count: 1, slot: 36 } } };
    if (url === "/inventory") return { ok: true, result: { items: [{ name: "stone_pickaxe", count: 1, slot: 36 }] } };
    if (url === "/get_block") return { ok: true, result: { name: tower.has(body.pos.join(",")) ? "cobblestone" : body.pos[1] < 64 ? "stone" : "air" } };
    if (url === "/dig") { assert.equal(body.collect, false);assert.ok(tower.delete(body.pos.join(",")));digs.push(body.pos);pos[1]--;return { ok: true, result: {} }; }
    throw new Error(`unexpected ${url}`);
  } }, async bridge => {
    const outcome = await bridge.run("mark_anchor", { name: "ground" }).promise;
    assert.deepEqual(outcome.result.pos, [0, 64, 0]);assert.deepEqual(digs, [[0, 65, 0], [0, 64, 0]]);
  }, { anchors: {}, routes: {}, workareas: [], treePillar: { active: true, dimension: "overworld", base: [0, 64, 0], phase: "up", placed: [{ pos: [0, 64, 0], item: "cobblestone", confirmed: true }, { pos: [0, 65, 0], item: "cobblestone", confirmed: false }] } });
});
test("one temporary bench stays throughout a multi-product workshop and is reclaimed last", async () => {
  await workshopFixture(false, async ({ bridge, events, stock }) => {
    await bridge.run("workshop", workshopJob).promise;
    assert.deepEqual(events, ["place", "craft:stone_axe", "craft:stone_pickaxe", "dig"]);
    assert.equal(stock.crafting_table, 1);
  });
});

test("crafting failure retains the temporary bench and its persistent location", async () => {
  await workshopFixture(true, async ({ bridge, events, hasBench }) => {
    await assert.rejects(bridge.run("workshop", workshopJob).promise, /simulated crafting failure/);
    assert.ok(hasBench());assert.ok(!events.includes("dig"));
    const saved = JSON.parse(await readFile(bridge.stateFile, "utf8"));
    assert.equal(saved.temporaryWorkbench.dimension, "overworld");
  });
});

test("drop collection tries another supported position after a local movement failure", async () => {
  let pos = [0.5, 64, 0.5], iron = 0;const moves = [];
  await fixture({ async request(url, { body = {} } = {}) {
    if (url === "/status") return { ok: true, result: { alive: true, ready: true, health: 20, pos, dimension: "overworld" } };
    if (url === "/inventory") return { ok: true, result: { items: [{ name: "raw_iron", count: iron }], empty_slots: 30 } };
    if (url === "/get_entities") return { ok: true, result: { entities: [{ name: "item", item: "raw_ironx3", pos: [5.2, 64.1, 0.5] }] } };
    if (url === "/get_block") return { ok: true, result: { name: body.pos[1] < 64 ? "stone" : "air" } };
    if (url === "/move_to") {
      moves.push(body.x);if (body.x === 5.5) return { ok: false, error: { code: "path_not_found", message: "blocked" } };
      pos = [body.x, body.y, body.z];iron = 3;return { ok: true, result: {} };
    }
    throw new Error(`unexpected ${url}`);
  } }, async bridge => {
    const outcome = await bridge.run("collect_drops", { types: ["raw_iron"], radius: 6 }).promise;
    assert.equal(outcome.result.gained, 3);assert.equal(outcome.result.skipped, 0);
    assert.deepEqual(moves, [5.5, 6.5]);
  });
});

test("workstation approach tries another side after its closest standing cell is unreachable", async () => {
  let pos = [0.5, 64, 0.5], chest = 0;const moves = [];
  const cells = new Set(["0,64,0", "7,64,0", "8,64,1"]);
  await fixture({ async request(url, { body = {} } = {}) {
    if (url === "/status") return { ok: true, result: { alive: true, ready: true, health: 20, pos, dimension: "overworld" } };
    if (url === "/inventory") return { ok: true, result: { items: [{ name: "oak_planks", count: 8 }, { name: "chest", count: chest }], empty_slots: 30 } };
    if (url === "/find_blocks") return { ok: true, result: { blocks: [{ pos: [8, 64, 0], name: "crafting_table" }] } };
    if (url === "/get_block") return { ok: true, result: { name: body.pos.join(",") === "8,64,0" ? "crafting_table" : body.pos[1] < 64 ? "stone" : body.pos[1] === 65 || cells.has(body.pos.join(",")) ? "air" : "stone" } };
    if (url === "/move_to") {
      moves.push([body.x, body.z]);if (body.x === 7.5) return { ok: false, error: { code: "path_not_found", message: "first side disconnected" } };
      pos = [body.x, body.y, body.z];return { ok: true, result: {} };
    }
    if (url === "/craft") { chest++;return { ok: true, result: {} }; }
    throw new Error(`unexpected ${url}`);
  } }, async bridge => {
    const outcome = await bridge.run("craft", { item: "chest", count: 1 }).promise;
    assert.equal(outcome.result.crafted, "chest");
    assert.ok(moves.some(([x, z]) => x === 7.5 && z === 0.5));
    assert.ok(moves.some(([x, z]) => x === 8.5 && z === 1.5));
  });
});

test("base resumes its saved height and dimensions and leaves a usable two-block doorway", async () => {
  let pos = [0.5, 67, 0.5];const placed = new Map();
  const stock = { cobblestone: 128, crafting_table: 1, furnace: 1, chest: 1 };
  await fixture({ async request(url, { body = {} } = {}) {
    if (url === "/status") return { ok: true, result: { alive: true, ready: true, health: 20, pos, dimension: "overworld" } };
    if (url === "/inventory") return { ok: true, result: { items: Object.entries(stock).map(([name, count]) => ({ name, count })), empty_slots: 30 } };
    if (url === "/get_block") return { ok: true, result: { name: placed.get(body.pos.join(",")) || (body.pos[1] < 64 ? "stone" : "air"), diggable: true } };
    if (url === "/move_to") { pos = [body.x, body.y, body.z];return { ok: true, result: {} }; }
    if (url === "/place") { placed.set(body.pos.join(","), body.item);stock[body.item]--;return { ok: true, result: {} }; }
    throw new Error(`unexpected ${url}`);
  } }, async bridge => {
    const outcome = await bridge.run("build_base", { name: "checkpoint", width: 9, depth: 9 }).promise;
    assert.deepEqual(outcome.result.min, [-2, 63, -2]);
    assert.deepEqual(outcome.result.max, [2, 66, 2]);
    assert.deepEqual(outcome.result.entrance, [2, 64, 0]);
    assert.deepEqual(outcome.result.exit, [3, 64, 0]);
    assert.ok(!placed.has("2,64,0") && !placed.has("2,65,0"));
    assert.ok(!placed.has("1,64,0"), "furniture must not block the door route");
    assert.deepEqual(pos, [0.5, 64, 0.5]);
  }, { anchors: {}, routes: {}, workareas: [], baseBuilds: { checkpoint: { center: [0, 64, 0], floorY: 63, width: 5, depth: 5, wallHeight: 3, material: "cobblestone", phase: "walls", complete: false, dimension: "overworld" } } });
});

test("zero-progress fishbone chooses a solid face at the new position without rewinding to the cave edge", async () => {
  let pos=[10.5,64,.5];const dug=new Set(),moves=[];
  const saved={anchors:{},routes:{},workareas:[],fishboneRoutes:{"fishbone:entry":{laneId:"entry",dimension:"overworld",origin:[0,64,0],end:[0,64,0],direction:[1,0,0],mainStep:0,length:1,branchLength:1,branchEvery:3,branchHub:3,branchSign:0,branchStep:0,branches:[],phase:"main"}}};
  await fixture({async request(url,{body={}}={}){
    if(url==="/status")return {ok:true,result:{alive:true,ready:true,health:20,pos,dimension:"overworld",held:{name:"stone_pickaxe",count:1,slot:36}}};
    if(url==="/inventory")return {ok:true,result:{items:[{name:"stone_pickaxe",count:1,slot:36}],empty_slots:30}};
    if(url==="/find_blocks")return {ok:true,result:{blocks:[]}};
    if(url==="/get_block")return {ok:true,result:{name:dug.has(body.pos.join(","))||body.pos[0]>=10&&body.pos[1]>=64?"air":"stone",diggable:true}};
    if(url==="/dig"){assert.ok([64,65].includes(body.pos[1]));dug.add(body.pos.join(","));return {ok:true,result:{}};}
    if(url==="/move_to"){moves.push(body.x);assert.ok(body.x>=9.5,"must not return to provisional origin");pos=[body.x,body.y,body.z];return {ok:true,result:{}};}
    throw new Error(`unexpected ${url}`);
  }},async bridge=>{
    const outcome=await bridge.run("fishbone_mine",{laneId:"entry"}).promise;
    assert.equal(outcome.result.stopReason,"lane_complete");assert.deepEqual(outcome.result.origin,[10,64,0]);assert.deepEqual(outcome.result.mainEnd,[9,64,0]);
    assert.deepEqual(outcome.state.fishboneRoutes["fishbone:entry"].direction,[-1,0,0]);assert.equal(dug.size,2);assert.deepEqual(moves,[9.5]);
  },saved);
});

test("committed fishbone retains its origin and direction when a later open space blocks mining", async () => {
  let pos=[1.5,64,.5];
  const saved={anchors:{},routes:{},workareas:[],fishboneRoutes:{"fishbone:fixed":{laneId:"fixed",dimension:"overworld",origin:[0,64,0],end:[1,64,0],direction:[1,0,0],mainStep:1,length:2,branchLength:1,branchEvery:3,branchHub:3,branchSign:0,branchStep:0,branches:[],phase:"main"}}};
  await fixture({async request(url,{body={}}={}){
    if(url==="/status")return {ok:true,result:{alive:true,ready:true,health:20,pos,dimension:"overworld",held:{name:"stone_pickaxe",count:1,slot:36}}};
    if(url==="/inventory")return {ok:true,result:{items:[{name:"stone_pickaxe",count:1,slot:36}],empty_slots:30}};
    if(url==="/find_blocks")return {ok:true,result:{blocks:[]}};
    if(url==="/get_block")return {ok:true,result:{name:body.pos[1]<64||(body.pos[0]===2&&body.pos[2]===0)?"stone":"air"}};
    throw new Error(`unexpected ${url}`);
  }},async bridge=>{
    const outcome=await bridge.run("fishbone_mine",{laneId:"fixed"}).promise;
    assert.equal(outcome.result.stopReason,"lane_complete");const lane=outcome.state.fishboneRoutes["fishbone:fixed"];
    assert.equal(lane.mainBlocked.code,"open_space_ahead");
    assert.deepEqual(lane.origin,[0,64,0]);assert.deepEqual(lane.direction,[1,0,0]);assert.equal(lane.mainStep,1);
  },saved);
});

test("stone-pick fishbone defers diamond while continuing to mine iron and its two-block lane",async()=>{
  let pos=[.5,64,.5],raw=0;const dug=new Set();
  const ores=new Map([["0,64,-1","diamond_ore"],["0,64,1","iron_ore"]]);
  await fixture({async request(url,{body={}}={}){
    if(url==="/status")return {ok:true,result:{alive:true,ready:true,health:20,pos,dimension:"overworld",held:{name:"stone_pickaxe",count:1,slot:36}}};
    if(url==="/inventory")return {ok:true,result:{items:[{name:"stone_pickaxe",count:1,slot:36},{name:"raw_iron",count:raw}],empty_slots:30}};
    if(url==="/find_blocks")return {ok:true,result:{blocks:[...ores].filter(([key])=>!dug.has(key)).map(([key,name])=>({pos:key.split(",").map(Number),name}))}};
    if(url==="/get_block"){const key=body.pos.join(",");return {ok:true,result:{name:dug.has(key)||body.pos[0]===0&&body.pos[2]===0&&body.pos[1]>=64?"air":ores.get(key)||"stone",diggable:true}};}
    if(url==="/dig"){const key=body.pos.join(",");assert.notEqual(key,"0,64,-1","stone pick must not destroy the diamond");if(ores.get(key)==="iron_ore")raw++;dug.add(key);return {ok:true,result:{}};}
    if(url==="/move_to"){pos=[body.x,body.y,body.z];return {ok:true,result:{}};}
    throw new Error(`unexpected ${url}`);
  }},async bridge=>{
    const outcome=await bridge.run("fishbone_mine",{laneId:"tiers",direction:"x",length:1,branchEvery:3}).promise;
    assert.equal(outcome.result.stopReason,"lane_complete");assert.equal(raw,1);
    const pending=Object.values(outcome.state.deferredOres);assert.equal(pending.length,1);assert.deepEqual(pending[0].pos,[0,64,-1]);assert.equal(pending[0].requiredTier,3);
    assert.equal(outcome.state.fishboneRoutes["fishbone:tiers"].mainStep,1);
  });
});

test("explicit diamond mining reports insufficient tool tier rather than no pick",async()=>{
  await fixture({async request(url,{body={}}={}){
    if(url==="/status")return {ok:true,result:{alive:true,ready:true,health:20,pos:[.5,64,.5],dimension:"overworld"}};
    if(url==="/inventory")return {ok:true,result:{items:[{name:"stone_pickaxe",count:4}],empty_slots:30}};
    if(url==="/find_blocks")return {ok:true,result:{blocks:[{pos:[1,64,0],name:"diamond_ore"}]}};
    if(url==="/get_block")return {ok:true,result:{name:body.pos.join(",")==="1,64,0"?"diamond_ore":body.pos[1]<64?"stone":"air"}};
    throw new Error(`unexpected ${url}`);
  }},async bridge=>{
    await assert.rejects(bridge.run("mine_vein",{types:["diamond_ore"],targetCount:1}).promise,e=>e.code==="insufficient_tool_tier"&&e.details.availableTier===2&&e.details.requiredTier===3);
  });
});
