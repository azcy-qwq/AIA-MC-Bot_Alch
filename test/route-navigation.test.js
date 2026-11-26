import test from "node:test";
import assert from "node:assert/strict";
import { RouteMemory } from "../src/navigation/route-memory.js";
import { RouteNavigationSkill } from "../src/skills/route-navigation.js";

test("route navigation records first waypoints and reuses validated routes", async () => {
  const moves = [];
  const api = {
    getBlock: async ({ pos }) => ({ result: { name: pos[1] < 64 ? "stone" : "air", pos } }),
    moveTo: async params => (moves.push(params), { ok: true })
  };
  const memory = new RouteMemory();
  memory.setAnchor("surface", [0, 64, 0]);
  memory.setAnchor("mine", [10, 64, 0]);
  const skill = new RouteNavigationSkill({ api, worldModel: { latest: {} }, routeMemory: memory });
  const first = await skill.navigate({ from: "surface", to: "mine", waypoints: [[3, 64, 0], [10, 64, 0]] });
  const second = await skill.navigate({ from: "surface", to: "mine" });
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(moves.length, 4);
});

test("route navigation keeps legal points, replaces illegal points nearby, and skips short middle points", async () => {
  const moves = [];
  const api = {
    getBlock: async ({ pos }) => {
      const [x, y, z] = pos;
      if (y === 64 && x === 3 && z === 0) return { result: { name: "lava", pos } };
      if (y === 64 && x === 5 && z === 0) return { result: { name: "stone", pos } };
      if (y === 64 && x === 8 && z === 0) return { result: { name: "stone", pos } };
      return { result: { name: y < 64 ? "stone" : "air", pos } };
    },
    moveTo: async params => (moves.push(params), { ok: true })
  };
  const memory = new RouteMemory();
  memory.setAnchor("surface", [0, 64, 0]);
  memory.setAnchor("mine", [12, 64, 0]);
  const skill = new RouteNavigationSkill({ api, worldModel: { latest: {} }, routeMemory: memory });
  const result = await skill.navigate({ from: "surface", to: "mine", waypoints: [[0, 64, 0], [3, 64, 0], [5, 64, 0], [8, 64, 0], [12, 64, 0]] });
  assert.equal(result.cached, false);
  assert.ok(result.waypoints.some(point => point[0] !== 3 || point[2] !== 0));
  assert.ok(result.waypoints.every((point, index, list) => index === 0 || point[0] === 12 || Math.hypot(point[0] - list[index - 1][0], point[2] - list[index - 1][2]) >= 5));
  assert.equal(moves.length, result.waypoints.length);
});
