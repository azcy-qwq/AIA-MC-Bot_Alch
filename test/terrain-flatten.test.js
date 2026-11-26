import test from "node:test";
import assert from "node:assert/strict";
import { TerrainFlattenSkill } from "../src/skills/terrain-flatten.js";

test("terrain flatten scans a bounded area and applies public dig/place API calls", async () => {
  const placed = [];
  const dug = [];
  const api = {
    inventory: async () => ({ result: { items: [{ name: "cobblestone", count: 20 }] } }),
    getBlock: async ({ pos }) => ({ result: { name: pos[1] === 63 ? "stone" : "air", diggable: true, pos } }),
    place: async params => (placed.push(params), { ok: true }),
    dig: async params => (dug.push(params), { ok: true })
  };
  const skill = new TerrainFlattenSkill({ api, worldModel: { latest: { status: { pos: [0, 64, 0] } } }, plannerPath: "missing-terrain-planner" });
  const result = await skill.run({ center: [0, 64, 0], radius: 1, targetY: 64, scanBelow: 1, scanAbove: 1, maxOperations: 20, logger: { warn() {} } });
  assert.equal(result.placed, 9);
  assert.equal(placed.length, 9);
  assert.equal(dug.length, 0);
  assert.ok(placed.every(item => item.item === "cobblestone"));
});
