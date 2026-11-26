import test from "node:test";
import assert from "node:assert/strict";
import { ActionExecutor } from "../src/action/action-executor.js";

function createApi() {
  const calls = [];
  return {
    calls,
    inventory: async () => ({ result: { items: [{ name: "cobblestone", count: 2 }, { name: "water_bucket", count: 1 }] } }),
    place: async params => (calls.push(["place", params]), { ok: true }),
    useItem: async params => (calls.push(["use_item", params]), { ok: true }),
    drop: async params => (calls.push(["drop", params]), { ok: true })
  };
}

test("resource actions check inventory before calling the API", async () => {
  const api = createApi();
  const executor = new ActionExecutor({ api });
  await executor.enqueue({ type: "place", params: { item: "cobblestone" } }, { attempts: 1 });
  await executor.enqueue({ type: "use_item", params: { item: "water_bucket" } }, { attempts: 1 });
  await assert.rejects(() => executor.enqueue({ type: "drop", params: { item: "diamond" } }, { attempts: 1 }), error => error.code === "missing_item");
  assert.deepEqual(api.calls.map(call => call[0]), ["place", "use_item"]);
});

test("resource preflight rejects malformed actions without an API action call", async () => {
  const api = createApi();
  const executor = new ActionExecutor({ api });
  await assert.rejects(() => executor.enqueue({ type: "place", params: {} }, { attempts: 1 }), error => error.code === "bad_args");
  assert.deepEqual(api.calls, []);
});

test("place checks the target and a solid neighbour before calling the API", async () => {
  let placed = 0;
  const api = {
    inventory: async () => ({ result: { items: [{ name: "crafting_table", count: 1 }] } }),
    getBlock: async ({ pos }) => ({ result: { name: pos[0] === 1 ? "stone" : "air" } }),
    place: async () => { placed++; }
  };
  const executor = new ActionExecutor({ api });
  await assert.rejects(executor.enqueue({ type: "place", params: { item: "crafting_table", pos: [1, 64, 0] } }, { attempts: 1 }), error => error.code === "occupied");
  const unsupported = new ActionExecutor({ api: { ...api, getBlock: async () => ({ result: { name: "air" } }) } });
  await assert.rejects(unsupported.enqueue({ type: "place", params: { item: "crafting_table", pos: [2, 64, 0] } }, { attempts: 1 }), error => error.code === "no_support");
  assert.equal(placed, 0);
});

test("ordinary dig also collects nearby exposed ore without opening a tunnel", async () => {
  const dug = [];
  const api = {
    getBlock: async ({ pos }) => ({ result: { name: pos[0] === 1 && pos[1] === 64 ? "iron_ore" : "stone" } }),
    dig: async ({ pos }) => { dug.push(pos); return { ok: true }; },
    findBlocks: async () => ({ result: { blocks: [{ name: "iron_ore", pos: [1, 64, 0] }] } })
  };
  api.getBlock = async ({ pos }) => ({ result: {
    name: pos[0] === 0 && pos[1] === 64 && pos[2] === 0 ? "stone"
      : pos[0] === 1 && pos[1] === 64 && pos[2] === 0 ? "iron_ore"
        : pos[0] === 2 && pos[1] === 64 && pos[2] === 0 ? "air" : "stone"
  } });
  const executor = new ActionExecutor({ api });
  await executor.enqueue({ type: "dig", params: { pos: [0, 64, 0], single: true } }, { attempts: 1 });
  assert.deepEqual(dug, [[0, 64, 0], [1, 64, 0]]);
});
