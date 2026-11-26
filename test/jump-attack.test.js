import test from "node:test";
import assert from "node:assert/strict";
import { PveCombatScript } from "../src/skills/pve-combat.js";

function fixture() {
  let jumped = false;
  const calls = [];
  const status = { ready: true, alive: true, health: 20, on_ground: true, pos: [0.5, 64, 0.5], held: { name: "iron_sword" } };
  const api = {
    status: async () => ({ result: jumped ? { ...status, on_ground: false, velocity: [0, -1, 0] } : status }),
    getEntities: async () => ({ result: { entities: [{ id: 1, name: "zombie", pos: [2, 64, 0.5], dist: 1.5 }] } }),
    getBlock: async ({ pos }) => ({ result: { name: pos[1] === 63 ? "stone" : "air" } }),
    control() {}, look() {}
  };
  const script = new PveCombatScript({ api, executor: {} });
  const controls = { runAction: async action => { calls.push(action); if (action.params.jump) jumped = true; return { result: { hits: [{ entity: { id: 1 } }] } }; } };
  return { script, api, status, calls, controls };
}

test("jump attack jumps separately, observes descent, aims, then sends one hit", async () => {
  const { script, calls, controls } = fixture();
  const result = await script.jumpAttack({ entity_id: 1 }, controls);
  assert.equal(result.hit, true);
  assert.deepEqual(calls.map(c => [c.type, c.params]), [["control", { jump: true, ms: 100 }], ["look", { entity_id: 1 }], ["control", { hit: true, ms: 50 }]]);
});

test("jump attack refuses unsafe headroom and does not swing on ascent", async () => {
  const f = fixture();
  f.api.getBlock = async () => ({ result: { name: "stone" } });
  assert.equal((await f.script.jumpAttack({ entity_id: 1 }, f.controls)).attempted, false);
  assert.equal(f.calls.length, 0);
  const g = fixture();
  g.api.status = async () => ({ result: { ...g.status, on_ground: g.calls.length === 0, velocity: [0, 1, 0] } });
  const result = await g.script.jumpAttack({ entity_id: 1 }, g.controls);
  assert.equal(result.hit, false);
  assert.equal(g.calls.some(c => c.params.hit), false);
});
