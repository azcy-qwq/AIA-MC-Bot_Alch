import test from "node:test";
import assert from "node:assert/strict";
import { summarizeEnvironment } from "../src/core/environment-summary.js";

test("environment summaries round gameplay floats to one decimal", () => {
  const summary = summarizeEnvironment({
    status: { pos: [1.234, 64.678, -2.345], health: 17.876, food: 18.04, saturation: 3.333, xp_progress: 0.456 },
    entities: [{ id: 1, name: "zombie", type: "hostile", pos: [1.111, 2.222, 3.333], dist: 4.567, health: 19.99 }],
    blocks: { blocks: { stone: { count: 1, nearest: [1.234, 2.345, 3.456], dist: 5.678 } } }
  });
  assert.deepEqual(summary.status.position, [1.2, 64.7, -2.3]);
  assert.equal(summary.status.health, 17.9);
  assert.equal(summary.nearbyEntities[0].distance, 4.6);
  assert.deepEqual(summary.visibleBlocks.blocks.stone.nearest, [1.2, 2.3, 3.5]);
});
