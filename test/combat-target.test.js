import test from "node:test";
import assert from "node:assert/strict";
import { isDirectCombatThreat } from "../src/tac/combat-target.js";

test("ordinary combat ignores distant, hidden, and vertically misaligned hostiles", () => {
  const status = { pos: [0, 64, 0] };
  assert.equal(isDirectCombatThreat(status, { type: "hostile", dist: 3, pos: [2, 64, 1] }), true);
  assert.equal(isDirectCombatThreat(status, { type: "hostile", dist: 8, pos: [2, 64, 1] }), false);
  assert.equal(isDirectCombatThreat(status, { type: "hostile", dist: 3, pos: [2, 70, 1] }), false);
  assert.equal(isDirectCombatThreat(status, { type: "hostile", dist: 2, visible: false, pos: [1, 64, 1] }), false);
  assert.equal(isDirectCombatThreat(status, { type: "hostile", name: "enderman", dist: 2, pos: [1, 64, 1] }), false);
  assert.equal(isDirectCombatThreat(status, { type: "hostile", name: "enderman", dist: 2, pos: [1, 64, 1], confirmed_attacker: true }), true);
});
