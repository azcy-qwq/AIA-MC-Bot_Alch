import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeCraftingPlan,
  buildEarlyGameDAG,
  buildEarlyGameCraftingSnapshot
} from "../src/action/crafting-tree.js";
import { checkCraftRequirements } from "../src/action/recipe-checker.js";

test("early-game recipe graph is acyclic and exposes shared dependencies", () => {
  const graph = buildEarlyGameDAG();
  const indegree = new Map(graph.nodes.map(node => [node.id, 0]));
  const outgoing = new Map(graph.nodes.map(node => [node.id, []]));
  for (const edge of graph.edges) {
    indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1);
    outgoing.get(edge.from).push(edge.to);
  }
  const queue = [...indegree].filter(([, value]) => value === 0).map(([key]) => key);
  let visited = 0;
  while (queue.length) {
    const current = queue.shift();
    visited += 1;
    for (const next of outgoing.get(current) || []) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  assert.equal(visited, graph.nodes.length);
  assert.ok(graph.edges.some(edge => edge.from === "planks" && edge.to === "stick"));
  assert.ok(graph.edges.some(edge => edge.from === "stick" && edge.to === "stone_pickaxe"));
});

test("crafting tree consumes wood variants and reports the raw-log deficit", () => {
  const ready = analyzeCraftingPlan("wooden_pickaxe", 1, { items: [{ name: "birch_log", count: 3 }] });
  assert.equal(ready.ok, true);
  const short = analyzeCraftingPlan("wooden_pickaxe", 1, { items: [{ name: "birch_log", count: 2 }] });
  assert.equal(short.ok, false);
  assert.deepEqual(short.missing, [{ item: "log", need: 1, available: 0, missing: 1, reason: "raw_resource" }]);
});

test("iron tool planning includes furnace smelting and workstation prerequisites", () => {
  const result = analyzeCraftingPlan("iron_pickaxe", 1, {
    items: [
      { name: "oak_planks", count: 9 },
      { name: "cobblestone", count: 8 },
      { name: "raw_iron", count: 3 }
    ]
  });
  assert.equal(result.ok, true);
  assert.ok(result.tree.children.some(child => child.type === "smelt" && child.item === "iron_ingot"));
});

test("context snapshot evaluates default early targets and local preflight shares recipes", () => {
  const snapshot = buildEarlyGameCraftingSnapshot({ items: [{ name: "charcoal", count: 4 }, { name: "stick", count: 4 }] });
  const torch = snapshot.targets.find(target => target.item === "torch");
  assert.equal(torch.ok, true);
  assert.equal(checkCraftRequirements({ items: [{ name: "birch_planks", count: 8 }] }, "chest").ok, true);
  assert.equal(checkCraftRequirements({ items: [{ name: "cobbled_deepslate", count: 3 }, { name: "stick", count: 2 }] }, "stone_pickaxe").ok, true);
  assert.equal(checkCraftRequirements({ items: [{ name: "diamond", count: 3 }, { name: "stick", count: 2 }] }, "diamond_pickaxe").ok, true);
});
