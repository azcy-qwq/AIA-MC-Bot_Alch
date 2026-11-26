import test from "node:test";
import assert from "node:assert/strict";
import { WorldModel } from "../src/core/world-model.js";

test("WorldModel caches slower observations while keeping status and events fresh", async () => {
  const calls = { status: 0, inventory: 0, entities: 0, blocks: 0, facilities: 0, events: 0, advancements: 0 };
  const api = {
    status: async () => (calls.status++, { result: { ready: true, alive: true, health: 20 } }),
    inventory: async () => (calls.inventory++, { result: { items: [] } }),
    getEntities: async () => (calls.entities++, { result: { entities: [{ id: 9, name: "zombie" }] } }),
    findBlocks: async params => params.types ? (calls.facilities++, { result: { blocks: [{ name: "enchanting_table", pos: [4, 64, 0], dist: 4 }] } }) : (calls.blocks++, { result: { blocks: {} } }),
    events: async () => (calls.events++, { result: { last_seq: calls.events, events: [] } }),
    advancements: async () => (calls.advancements++, { result: { advancements: [] } })
  };
  const model = new WorldModel(api, { inventoryIntervalMs: 10_000, entitiesIntervalMs: 10_000, blocksIntervalMs: 10_000, advancementsIntervalMs: 10_000 });
  await model.refresh();
  await model.refresh();
  assert.deepEqual(model.latest.entities, [{ id: 9, name: "zombie" }]);
  assert.equal(calls.status, 2);
  assert.equal(calls.events, 2);
  assert.equal(calls.inventory, 1);
  assert.equal(calls.entities, 1);
  assert.equal(calls.blocks, 1);
  assert.equal(calls.facilities, 1);
  assert.deepEqual(model.latest.facilities.blocks[0].pos, [4, 64, 0]);
  assert.equal(calls.advancements, 1);
  await model.refresh({ force: true });
  assert.equal(calls.inventory, 2);
  assert.equal(calls.entities, 2);
  assert.equal(calls.blocks, 2);
  assert.equal(calls.facilities, 2);
  assert.equal(calls.advancements, 2);
});
