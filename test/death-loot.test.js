import test from "node:test";
import assert from "node:assert/strict";
import { DeathLootRecovery } from "../src/recovery/death-loot-recovery.js";

test("death recovery walks to dropped items and restores the old loadout", async () => {
  const actions = [];
  const api = {
    getEntities: async () => ({ result: { entities: [{ id: 1, type: "item", pos: [10, 63, 20], item: "diamond_sword" }] } }),
    inventory: async () => ({ result: { items: [{ name: "diamond_sword", count: 1 }, { name: "iron_helmet", count: 1 }], armor: {} } })
  };
  const executor = { enqueue: async action => (actions.push(action), { ok: true }) };
  const recovery = new DeathLootRecovery({ api, executor, worldModel: { latest: {} } });
  const result = await recovery.recover({
    deathEvent: { type: "death", dropped_items_at: [10, 63, 20], cause: "zombie" },
    previousInventory: { held: { name: "diamond_sword" }, armor: { head: { name: "iron_helmet" } } }
  });
  assert.equal(result.recovered, true);
  assert.deepEqual(actions.map(action => action.type), ["move_to", "equip", "equip"]);
  assert.deepEqual(actions[0].params, { x: 10, z: 20, range: 1 });
  assert.deepEqual(actions.slice(1).map(action => action.params), [{ item: "diamond_sword", slot: "hand" }, { item: "iron_helmet", slot: "head" }]);
});

test("death recovery skips safely when no death position or item entity is available", async () => {
  const recovery = new DeathLootRecovery({ api: { getEntities: async () => ({ result: { entities: [] } }) }, executor: { enqueue: async () => { throw new Error("should not enqueue"); } }, worldModel: { latest: {} } });
  const result = await recovery.recover({ deathEvent: { type: "death" } });
  assert.deepEqual(result, { attempted: false, reason: "no_drop_position" });
});

test("death recovery skips a water death position and does not force a vertical path", async () => {
  const calls = [];
  const api = {
    getEntities: async () => ({ result: { entities: [{ id: 1, type: "item", pos: [4, 62, 4] }] } }),
    getBlock: async ({ pos }) => ({ result: { name: pos[1] === 61 ? "water" : "air" } }),
    inventory: async () => ({ result: { items: [] } })
  };
  const executor = { enqueue: async action => calls.push(action) };
  const result = await new DeathLootRecovery({ api, executor, worldModel: { latest: {} } }).recover({ deathEvent: { pos: [4, 62, 4] } });
  assert.equal(result.attempted, false);
  assert.equal(calls.length, 0);
});

test("death recovery moves horizontally and verifies remaining item entities", async () => {
  let queried = 0; const calls = [];
  const api = {
    getEntities: async () => ({ result: { entities: queried++ ? [] : [{ id: 1, type: "item", pos: [4, 62, 4] }] } }),
    getBlock: async ({ pos }) => ({ result: { name: pos[1] === 61 ? "grass_block" : "air" } }),
    inventory: async () => ({ result: { items: [] } })
  };
  const executor = { enqueue: async action => calls.push(action) };
  const result = await new DeathLootRecovery({ api, executor, worldModel: { latest: {} } }).recover({ deathEvent: { pos: [4, 62, 4] } });
  assert.deepEqual(calls[0].params, { x: 4, z: 4, range: 1 });
  assert.equal(result.recovered, true);
});

test("death recovery skips when a hostile is already within strike range", async () => {
  let moved = false;
  const api = { getEntities: async () => ({ result: { entities: [{ id: 4, type: "item", pos: [4, 62, 4] }] } }), getBlock: async () => ({ result: { name: "grass_block" } }) };
  const executor = { enqueue: async () => { moved = true; } };
  const result = await new DeathLootRecovery({ api, executor, worldModel: { latest: { entities: [{ type: "hostile", dist: 5 }] } } }).recover({ deathEvent: { pos: [4, 62, 4] } });
  assert.deepEqual(result, { attempted: false, reason: "nearby_hostile" });
  assert.equal(moved, false);
});

test("death recovery skips a far drop after respawn", async () => {
  const api = { getEntities: async () => ({ result: { entities: [] } }), getBlock: async () => ({ result: { name: "grass_block" } }) };
  const executor = { enqueue: async () => { throw new Error("must not move"); } };
  const result = await new DeathLootRecovery({ api, executor, worldModel: { latest: { status: { pos: [0, 70, 0] }, entities: [] } } }).recover({ deathEvent: { pos: [30, 70, 0] } });
  assert.equal(result.attempted, false);
  assert.equal(result.reason, "drop_too_far");
});
