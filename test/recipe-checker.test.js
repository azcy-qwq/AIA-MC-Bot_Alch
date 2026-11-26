import test from "node:test";
import assert from "node:assert/strict";
import { checkCraftRequirements } from "../src/action/recipe-checker.js";
import { ActionExecutor } from "../src/action/action-executor.js";

test("craft is rejected locally when known ingredients are missing", async () => {
  let craftCalled = false;
  const api = {
    inventory: async () => ({ result: { items: [{ name: "oak_planks", count: 2 }] } }),
    craft: async () => (craftCalled = true, { ok: true })
  };
  const executor = new ActionExecutor({ api });
  await assert.rejects(() => executor.enqueue({ type: "craft", params: { item: "crafting_table" } }, { attempts: 1 }), error => error.code === "missing_ingredients");
  assert.equal(craftCalled, false);
  assert.equal(checkCraftRequirements({ items: [{ name: "oak_planks", count: 4 }] }, "crafting_table").ok, true);
});

test("wood recipes accept birch planks and other plank variants", () => {
  assert.equal(checkCraftRequirements({ items: [{ name: "birch_planks", count: 4 }] }, "crafting_table").ok, true);
  assert.equal(checkCraftRequirements({ items: [{ name: "birch_planks", count: 2 }] }, "stick").ok, true);
  assert.equal(checkCraftRequirements({ items: [{ name: "dark_oak_planks", count: 3 }, { name: "stick", count: 2 }] }, "wooden_pickaxe").ok, true);
});

test("torch preflight accepts charcoal as a coal substitute", () => {
  const inventory = { items: [{ name: "charcoal", count: 8 }, { name: "stick", count: 8 }] };
  assert.equal(checkCraftRequirements(inventory, "torch", 8).ok, true);
  assert.equal(checkCraftRequirements({ items: [{ name: "charcoal", count: 1 }, { name: "stick", count: 8 }] }, "torch", 8).missing[0].need, 2);
});

test("known recipes cannot be bypassed with model-supplied requirements", () => {
  const check = checkCraftRequirements({ items: [{ name: "charcoal", count: 5 }, { name: "stick", count: 5 }] }, "torch", 32, []);
  assert.equal(check.ok, false);
  assert.deepEqual(check.missing, [{ item: "coal", need: 8, available: 5 }, { item: "stick", need: 8, available: 5 }]);
});

test("craft preflight blocks the API when the requested batch lacks materials", async () => {
  let craftCalled = false;
  const events = [];
  const api = {
    inventory: async () => ({ result: { items: [{ name: "charcoal", count: 5 }, { name: "stick", count: 5 }] } }),
    craft: async () => (craftCalled = true, { ok: true })
  };
  const executor = new ActionExecutor({ api });
  executor.events.on("action-preflight", event => events.push(event));
  await assert.rejects(() => executor.enqueue({ type: "craft", params: { item: "torch", count: 32 } }, { source: "action:torch", attempts: 1 }), error => error.code === "missing_ingredients");
  assert.equal(craftCalled, false);
  assert.equal(events.length, 1);
  assert.equal(events[0].ok, false);
  assert.deepEqual(events[0].missing, [{ item: "coal", need: 8, available: 5 }, { item: "stick", need: 8, available: 5 }]);
});

test("ordinary strategy stone digging is bounded by a runtime quota", async () => {
  const dug = [];
  const api = {
    findBlocks: async () => ({ result: { blocks: Array.from({ length: 20 }, (_, index) => ({ name: "stone", pos: [index, 10, 0], diggable: true })) } }),
    dig: async ({ pos }) => (dug.push(pos), { ok: true })
  };
  const executor = new ActionExecutor({ api });
  const first = await executor.enqueue({ type: "dig_many", params: { types: ["stone"], limit: 20 } }, { source: "action:collect", attempts: 1 });
  assert.equal(first.dug, 12);
  await assert.rejects(() => executor.enqueue({ type: "dig_many", params: { types: ["stone"], limit: 2 } }, { source: "action:collect", attempts: 1 }), error => error.code === "common_block_budget_exhausted");
  assert.equal(dug.length, 12);
});
