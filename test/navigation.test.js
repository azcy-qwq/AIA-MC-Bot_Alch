import test from "node:test";
import assert from "node:assert/strict";
import { NavigationSkill } from "../src/skills/navigation.js";

test("bridge navigation places supports and advances one target at a time", async () => {
  const placed = [];
  const moved = [];
  let position = [0, 64, 0];
  const api = {
    status: async () => ({ result: { pos: position, on_ground: true } }),
    inventory: async () => ({ result: { items: [{ name: "cobblestone", count: 8 }] } }),
    posture: async () => ({ ok: true }),
    getBlock: async ({ pos }) => {
      const key = pos.join(",");
      if (placed.some(item => item.pos.join(",") === key)) return { result: { name: "cobblestone", pos } };
      return { result: { name: pos[1] === 63 && pos[0] === 0 ? "stone" : "air", pos } };
    },
    place: async params => (placed.push(params), { ok: true }),
    moveTo: async params => (moved.push(params), { ok: true, result: { pos: position = [params.x, params.y, params.z] } })
  };
  const result = await new NavigationSkill({ api, worldModel: { latest: {} } }).bridgeTo({ target: [2, 64, 0], maxSteps: 4 });
  assert.equal(result.placed, 2);
  assert.equal(result.moved, 2);
  assert.deepEqual(moved.map(item => [item.x, item.z]), [[1, 0], [2, 0]]);
});

test("staircase descent clears headroom and the extra overhead cell", async () => {
  const dug = [];
  let position = [0, 64, 0];
  const api = {
    status: async () => ({ result: { pos: position, on_ground: true } }),
    getBlock: async ({ pos }) => ({ result: { name: pos[1] === 62 ? "stone" : pos[1] === 65 ? "air" : "stone", pos, diggable: true } }),
    dig: async params => (dug.push(params.pos), { ok: true }),
    moveTo: async params => ({ ok: true, result: { pos: position = [params.x, params.y, params.z] } })
  };
  const result = await new NavigationSkill({ api, worldModel: { latest: {} } }).staircaseDown({ direction: "z", steps: 2 });
  assert.equal(result.steps, 2);
  assert.equal(dug.length, 5);
  assert.deepEqual(result.position, [0, 62, 2]);
});

test("staircase navigation can ascend through a blocked ceiling", async () => {
  const dug = [];
  const moved = [];
  let position = [0, 64, 0];
  const api = {
    status: async () => ({ result: { pos: position, on_ground: true } }),
    getBlock: async ({ pos }) => ({ result: { name: pos[1] === 64 ? "stone" : pos[1] === 65 || pos[1] === 66 ? "stone" : "air", pos, diggable: true } }),
    dig: async params => (dug.push(params.pos), { ok: true }),
    moveTo: async params => (moved.push(params), { ok: true, result: { pos: position = [params.x, params.y, params.z] } })
  };
  const result = await new NavigationSkill({ api, worldModel: { latest: {} } }).staircaseUp({ direction: "z", steps: 2 });
  assert.equal(result.mode, "staircase_up");
  assert.equal(result.dug, 4);
  assert.deepEqual(result.position, [0, 66, 2]);
  assert.equal(moved.length, 2);
});

test("navigation recovery uses direct movement before digging a staircase", async () => {
  const moves = [];
  const dug = [];
  let position = [0, 64, 0];
  const api = {
    status: async () => ({ result: { pos: position, on_ground: true } }),
    moveTo: async params => (moves.push(params), { ok: true, result: { pos: position = [params.x, params.y, params.z] } }),
    getBlock: async ({ pos }) => ({ result: { name: pos[1] < 64 ? "stone" : "air", pos, diggable: true } }),
    dig: async params => (dug.push(params), { ok: true })
  };
  const result = await new NavigationSkill({ api, worldModel: { latest: { inventory: { items: [] } } } }).recover({ target: [0, 62, 2], mode: "staircase", steps: 4 });
  assert.equal(result.mode, "direct");
  assert.equal(dug.length, 0);
  assert.deepEqual(moves[0], { x: 0, y: 62, z: 2, range: 1 });
});

test("staircase digging starts only after direct movement reports no path", async () => {
  const moves = [];
  const dug = [];
  let position = [0, 64, 0];
  const api = {
    status: async () => ({ result: { pos: position, on_ground: true } }),
    moveTo: async params => { moves.push(params); if (moves.length === 1) throw Object.assign(new Error("blocked"), { code: "path_not_found" }); return { ok: true, result: { pos: position = [params.x, params.y, params.z] } }; },
    getBlock: async ({ pos }) => ({ result: { name: pos[1] < 64 ? "stone" : "air", pos, diggable: true } }),
    dig: async params => (dug.push(params), { ok: true })
  };
  const result = await new NavigationSkill({ api, worldModel: { latest: { inventory: { items: [] } } } }).recover({ target: [0, 62, 2], mode: "staircase", steps: 1 });
  assert.equal(result.mode, "staircase");
  assert.ok(dug.length > 0);
  assert.equal(moves[0].y, 62);
});

test("staircase up rejects an undiggable overhead cell before moving", async () => {
  const moved = [];
  let position = [0, 64, 0];
  const api = {
    status: async () => ({ result: { pos: position, on_ground: true } }),
    getBlock: async ({ pos }) => ({ result: { name: pos[1] === 67 ? "bedrock" : "stone", pos, diggable: pos[1] !== 67 } }),
    dig: async () => ({ ok: true }),
    moveTo: async params => (moved.push(params), { ok: true, result: { pos: position = [params.x, params.y, params.z] } })
  };
  await assert.rejects(() => new NavigationSkill({ api, worldModel: { latest: {} } }).staircaseUp({ direction: "z", steps: 1 }), error => ["undiggable", "unsafe_navigation"].includes(error.code));
  assert.equal(moved.length, 0);
});

test("staircase refuses a transient jump apex as a completed step", async () => {
  let moved = false, reads = 0;
  const api = {
    status: async () => ({ result: moved && reads++ === 0 ? { pos: [0.5, 65, 1.5], on_ground: false } : { pos: [0.5, 64, 0.5], on_ground: true } }),
    getBlock: async ({ pos }) => ({ result: { name: pos[1] <= 64 ? "stone" : "air", diggable: true } }),
    dig: async () => ({ ok: true }),
    moveTo: async () => { moved = true; return { result: { pos: [0.5, 65, 1.5] } }; }
  };
  await assert.rejects(new NavigationSkill({ api }).staircaseUp({ direction: "z", steps: 2 }), error => error.code === "navigation_failed");
  assert.ok(reads > 1);
});

test("staircase does not excavate an important block or unknown cell", async () => {
  for (const cell of [{ name: "chest", diggable: true }, {}]) {
    let digs = 0;
    const api = {
      status: async () => ({ result: { pos: [0.5, 64, 0.5] } }),
      getBlock: async ({ pos }) => ({ result: pos[1] <= 64 ? { name: "stone" } : cell }),
      dig: async () => { digs++; }
    };
    await assert.rejects(new NavigationSkill({ api }).staircaseDown({ direction: "z", steps: 1 }), error => ["unknown_block", "unsafe_navigation"].includes(error.code));
    assert.equal(digs, 0);
  }
});

test("a fractional north target keeps its X column and stops at its requested height", async () => {
  let position = [-126.5, 65, -144.5];
  const moves = [];
  const api = {
    status: async () => ({ result: { pos: position, on_ground: true } }),
    getBlock: async ({ pos }) => ({ result: { name: pos[1] <= 65 ? "stone" : "air", diggable: true } }),
    dig: async () => ({ ok: true }),
    moveTo: async params => { moves.push(params); position = [params.x, params.y, params.z]; return { result: { pos: position } }; }
  };
  const result = await new NavigationSkill({ api }).staircaseUp({ target: [-126.5, 66, -145.5] });
  assert.equal(result.steps, 1);
  assert.equal(moves[0].x, -126.5);
  assert.equal(moves[0].z, -145.5);
});

test("stair construction refreshes its block observation when falling gravel has cleared it", async () => {
  let position = [0.5, 64, 0.5], reads = 0, digs = 0;
  const api = {
    status: async () => ({ result: { pos: position, on_ground: true } }),
    getBlock: async ({ pos }) => ({ result: { name: pos[1] <= 64 ? "stone" : ++reads <= 4 ? "gravel" : "air", diggable: true } }),
    dig: async () => { digs++; },
    moveTo: async params => ({ result: { pos: position = [params.x, params.y, params.z] } })
  };
  await new NavigationSkill({ api }).staircaseUp({ direction: "z", steps: 1 });
  assert.equal(digs, 0);
});

test("air stair passages skip digging and verify a filled support before moving", async () => {
  for (const mode of ["filled", "missing_material", "placement_not_applied"]) {
    let position = [0.5, 64, 0.5], filled = false, moves = 0;
    const api = {
      status: async () => ({ result: { pos: position, on_ground: true } }),
      inventory: async () => ({ result: { items: mode === "missing_material" ? [] : [{ name: "cobblestone", count: 1 }] } }),
      getBlock: async ({ pos }) => ({ result: { name: pos.join(",") === "0,62,1" ? filled ? "cobblestone" : "air" : pos[1] <= 62 ? "stone" : "air" } }),
      dig: async () => { assert.fail("air must not be dug"); },
      place: async () => { filled = mode === "filled"; },
      moveTo: async ({ x, y, z }) => { moves++; position = [x, y, z]; return { result: { pos: position } }; }
    };
    const pending = new NavigationSkill({ api }).staircaseDown({ direction: "z", steps: 1 });
    if (mode === "filled") {
      const result = await pending;
      assert.equal(result.dug, 0);
      assert.equal(result.placed, 1);
      assert.equal(moves, 1);
    } else {
      await assert.rejects(pending, error => ["no_support", "unsafe_navigation"].includes(error.code));
      assert.equal(moves, 0);
    }
  }
});
