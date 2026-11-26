import test from "node:test";
import assert from "node:assert/strict";
import { AutonomousWorkScript } from "../src/skills/autonomous-work.js";
import { ActionExecutor } from "../src/action/action-executor.js";
import { resolveStandDestination } from "../src/navigation/safe-destination.js";
import { TacController, normalizeTactics } from "../src/tac/tac-controller.js";
import { EventBus } from "../src/core/events.js";

function woodFixture() {
  let count = 0;
  const logs = [[1, 64, 0], [1, 65, 0], [2, 64, 0]];
  const removed = new Set();
  const status = { alive: true, ready: true, health: 20, food: 20, pos: [0.5, 64, 0.5] };
  const api = {
    status: async () => ({ result: status }),
    inventory: async () => ({ result: { items: [{ name: "birch_log", count }], empty_slots: 35 } }),
    findBlocks: async () => ({ result: { blocks: logs.filter(p => !removed.has(p.join(","))).map(pos => ({ pos, name: "birch_log" })) } }),
    getBlock: async ({ pos }) => ({ result: { name: pos[1] < 64 ? "stone" : !removed.has(pos.join(",")) && logs.some(p => p.join(",") === pos.join(",")) ? "birch_log" : "air" } }),
    dig: async ({ pos }) => { removed.add(pos.join(",")); count++; return { result: {} }; }
  };
  return { api, status, removed };
}

test("one queued wood job loops until the inventory target without nested queue deadlock", async () => {
  const { api, removed } = woodFixture();
  const executor = new ActionExecutor({ api });
  const script = new AutonomousWorkScript({ api });
  executor.registerSkillAction("chop_tree", (params, onProgress, controls) => script.run({ ...params, mode: "chop_tree" }, { ...controls, onProgress }));
  const result = await executor.enqueue({ type: "chop_tree", params: { targetCount: 3 } }, { attempts: 1 });
  assert.equal(result.complete, true);
  assert.equal(result.currentCount, 3);
  assert.equal(removed.size, 3);
  assert.equal(executor.workProgress, null);
  const alreadyDone = await executor.enqueue({ type: "chop_tree", params: { targetCount: 3 } }, { attempts: 1 });
  assert.equal(alreadyDone.mined, 0);
});

test("Tac cancellation stops a running work loop before a second dig", async () => {
  const { api } = woodFixture();
  let release, started;
  const began = new Promise(r => { started = r; });
  api.dig = async () => { started(); await new Promise(r => { release = r; }); return {}; };
  const executor = new ActionExecutor({ api });
  const script = new AutonomousWorkScript({ api });
  executor.registerSkillAction("chop_tree", (params, onProgress, controls) => script.run(params, { ...controls, onProgress }));
  const pending = executor.enqueue({ type: "chop_tree", params: { targetCount: 3 } }, { attempts: 1 });
  await began;
  executor.cancelPending("Tac priority"); release();
  await assert.rejects(pending, e => e.code === "cancelled");
});

test("fishbone work clears and follows the tunnel and stops on actual ore inventory", async () => {
  const dug = new Set();
  let iron = 0;
  const status = { alive: true, ready: true, health: 20, food: 20, pos: [0.5, 64, 0.5], held: { name: "stone_pickaxe" } };
  const api = {
    status: async () => ({ result: status }),
    inventory: async () => ({ result: { empty_slots: 30, items: [{ name: "stone_pickaxe", count: 1 }, { name: "raw_iron", count: iron }] } }),
    findBlocks: async () => ({ result: { blocks: [] } }),
    getBlock: async ({ pos }) => ({ result: { name: dug.has(pos.join(",")) || (pos[0] === 0 && pos[2] === 0 && pos[1] >= 64) ? "air" : pos.join(",") === "1,64,0" ? "iron_ore" : "stone" } }),
    dig: async ({ pos }) => { dug.add(pos.join(",")); if (pos.join(",") === "1,64,0") iron++; return {}; },
    moveTo: async ({ x, y, z }) => ({ result: { pos: (status.pos = [x, y, z]) } })
  };
  const executor = new ActionExecutor({ api });
  const script = new AutonomousWorkScript({ api });
  executor.registerSkillAction("fishbone_mine", (params, onProgress, controls) => script.run({ ...params, mode: "fishbone" }, { ...controls, onProgress }));
  const result = await executor.enqueue({ type: "fishbone_mine", params: { direction: "x", targetCount: 1, length: 10 } }, { attempts: 1 });
  assert.equal(result.complete, true);
  assert.equal(result.currentCount, 1);
  assert.equal(dug.size, 2);
  assert.deepEqual([...dug].sort(), ["1,64,0", "1,65,0"]);
});

test("equivalent destinations prefer the same Y and require two clear cells plus ground", async () => {
  const api = { getBlock: async ({ pos: [x, y, z] }) => ({ result: { name: y === 63 || (x === 5 && z === 0 && y === 65) ? "stone" : "air" } }) };
  const target = await resolveStandDestination(api, { x: 5, y: 65, z: 0, range: 1 }, [0.5, 64, 0.5]);
  assert.equal(target.y, 64);
  assert.notEqual(Math.floor(target.x), 5); // original column has head obstruction
  await assert.rejects(resolveStandDestination({ getBlock: async () => ({ result: null }) }, { x: 5, y: 64, z: 0 }, [0, 64, 0]), e => e.code === "unsafe_navigation");
  await assert.rejects(resolveStandDestination(api, { x: 5, y: 64, z: 0, exact: true }, [0, 64, 0]), e => e.code === "unsafe_navigation");
});

test("an emergency starts the attack script before shielding or model advice", async () => {
  const order = [], status = { alive: true, ready: true, health: 20, food: 20, pos: [0, 64, 0], offhand: { name: "shield" } };
  const worldModel = { latest: { status, inventory: {}, entities: [{ id: 1, type: "hostile", pos: [2, 64, 0], dist: 2 }] }, events: new EventBus() };
  const api = { status: async () => ({ result: status }), inventory: async () => ({ result: { items: [] } }) };
  const executor = { busy: false, cancelPending: () => {}, enqueue: async a => { order.push(a.type); } };
  const tac = new TacController({ api, executor, worldModel, pve: { firstStrike: async () => (order.push("attack-script"), {}) }, provider: { createTactics: async () => (order.push("model"), { urgent: true, responses: ["shield"] }) } });
  await tac.tick();
  assert.equal(order[0], "attack-script");
  assert.ok(order.includes("posture"));
  tac.stop();
});

test("Tac can detect unclassified risk without polling a model in a stable safe scene", async () => {
  assert.deepEqual(normalizeTactics({ urgent: "false", responses: "flee shelter unknown" }), { urgent: false, reason: "", responses: ["flee", "shelter"] });
  let calls = 0;
  const worldModel = { latest: { status: { alive: true, ready: true, health: 20, pos: [0, 64, 0], on_ground: true }, entities: [] }, events: new EventBus() };
  const tac = new TacController({ api: {}, executor: {}, worldModel, provider: { createTactics: async () => (calls++, { urgent: false }) } });
  await tac.tick(); assert.equal(calls, 0);
  worldModel.latest.status.health = 11;
  await tac.tick(); await Promise.resolve();
  assert.equal(calls, 1);
  await tac.tick(); assert.equal(calls, 1);
  tac.stop();
});
