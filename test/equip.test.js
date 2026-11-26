import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEquipParams } from "../src/action/equip-normalizer.js";
import { ActionExecutor } from "../src/action/action-executor.js";

const inventory = { items: [
  { name: "stone_sword", count: 1, slot: 33 },
  { name: "iron_helmet", count: 1, slot: 5 },
  { name: "shield", count: 1, slot: 40 }
] };

test("equip converts a backpack slot number into the correct API slot", () => {
  assert.deepEqual(normalizeEquipParams({ item: "stone_sword", slot: 33 }, inventory), { item: "stone_sword", slot: "hand" });
  assert.deepEqual(normalizeEquipParams({ item: 5 }, inventory), { item: "iron_helmet", slot: "head" });
  assert.deepEqual(normalizeEquipParams({ item: "shield", slot: "offhand" }, inventory), { item: "shield", slot: "off-hand" });
});

test("ActionExecutor validates and normalizes equip before the HTTP call", async () => {
  const calls = [];
  const api = {
    inventory: async () => ({ result: inventory }),
    equip: async params => (calls.push(params), { ok: true, result: { held: params } })
  };
  const executor = new ActionExecutor({ api });
  await executor.enqueue({ type: "equip", params: { item: "stone_sword", slot: 33 } }, { attempts: 1 });
  assert.deepEqual(calls, [{ item: "stone_sword", slot: "hand" }]);
});

test("equip rejects unknown numeric destination instead of sending it to the API", async () => {
  assert.throws(() => normalizeEquipParams({ item: "stone_sword", slot: 99 }, inventory), error => error.code === "invalid_equip_slot");
});

test("weapons and tools cannot be moved to the offhand as an API workaround", async () => {
  for (const item of ["stone_sword", "iron_axe", "diamond_pickaxe", "bow", "crossbow", "trident", "mace"]) {
    assert.throws(() => normalizeEquipParams({ item, slot: "offhand" }, { items: [{ name: item, count: 1 }] }), error => error.code === "invalid_equip_slot" && error.details.requiredSlot === "hand");
    assert.deepEqual(normalizeEquipParams({ item, slot: "hand" }, { items: [{ name: item, count: 1 }] }), { item, slot: "hand" });
  }
  let calls = 0;
  const executor = new ActionExecutor({ api: { inventory: async () => ({ result: inventory }), equip: async () => { calls++; } } });
  await assert.rejects(executor.enqueue({ type: "equip", params: { item: "stone_sword", slot: "off-hand" } }, { attempts: 1 }), error => error.code === "invalid_equip_slot");
  assert.equal(calls, 0);
});

test("equip verifies that the server actually filled the requested slot", async () => {
  const executor = new ActionExecutor({ api: {
    inventory: async () => ({ result: inventory }),
    equip: async () => ({ ok: true }),
    status: async () => ({ result: { held: null, offhand: null, armor: {} } })
  } });
  await assert.rejects(executor.enqueue({ type: "equip", params: { item: "stone_sword", slot: "hand" } }, { attempts: 1 }), error => error.code === "equip_not_applied");
});

test("equip uses the cached status when a status response omits the slot field", async () => {
  const executor = new ActionExecutor({ api: {
    inventory: async () => ({ result: inventory }),
    equip: async () => ({ ok: true }),
    status: async () => ({ result: { ready: true } })
  }, worldModel: { latest: { status: { held: null } } } });
  await assert.rejects(executor.enqueue({ type: "equip", params: { item: "stone_sword", slot: "hand" } }, { attempts: 1 }), error => error.code === "equip_not_applied");
});
