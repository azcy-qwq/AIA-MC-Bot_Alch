/**
 * Early-game crafting knowledge used by both local preflight and LLM planning.
 *
 * The recipes intentionally use logical groups (planks, logs and stone) where
 * Minecraft accepts several interchangeable variants.  The graph is kept
 * acyclic: mined/smelted inputs always point towards a crafted output.
 */

const clean = value => String(value || "").trim().replace(/^minecraft:/i, "").toLowerCase();

const PLANKS = [
  "oak_planks", "spruce_planks", "birch_planks", "jungle_planks", "acacia_planks",
  "dark_oak_planks", "mangrove_planks", "cherry_planks", "bamboo_planks", "pale_oak_planks"
];
const LOGS = [
  "oak_log", "spruce_log", "birch_log", "jungle_log", "acacia_log", "dark_oak_log",
  "mangrove_log", "cherry_log", "pale_oak_log", "stripped_oak_log", "stripped_spruce_log",
  "stripped_birch_log", "stripped_jungle_log", "stripped_acacia_log", "stripped_dark_oak_log",
  "stripped_mangrove_log", "stripped_cherry_log", "stripped_pale_oak_log"
];
const STONE = ["cobblestone", "cobbled_deepslate", "blackstone"];

const ingredient = (item, count, extra = {}) => ({ item, count, ...extra });
const recipe = (item, output, inputs, extra = {}) => ({
  item, output: output ?? 1, inputs, kind: "craft", station: "crafting_table", ...extra
});

/** A compact, version-neutral subset of recipes needed during the first day. */
export const EARLY_GAME_RECIPES = Object.freeze([
  recipe("planks", 4, [ingredient("log", 1, { group: "logs" })], { station: "inventory", variants: PLANKS }),
  recipe("stick", 4, [ingredient("planks", 2, { group: "planks" })], { station: "inventory" }),
  recipe("crafting_table", 1, [ingredient("planks", 4, { group: "planks" })], { station: "inventory" }),
  recipe("wooden_pickaxe", 1, [ingredient("planks", 3, { group: "planks" }), ingredient("stick", 2)]),
  recipe("wooden_axe", 1, [ingredient("planks", 3, { group: "planks" }), ingredient("stick", 2)]),
  recipe("wooden_sword", 1, [ingredient("planks", 2, { group: "planks" }), ingredient("stick", 1)]),
  recipe("wooden_shovel", 1, [ingredient("planks", 1, { group: "planks" }), ingredient("stick", 2)]),
  recipe("wooden_hoe", 1, [ingredient("planks", 2, { group: "planks" }), ingredient("stick", 2)]),
  recipe("furnace", 1, [ingredient("cobblestone", 8, { group: "stone" })], { station: "crafting_table" }),
  recipe("stone_pickaxe", 1, [ingredient("cobblestone", 3, { group: "stone" }), ingredient("stick", 2)]),
  recipe("stone_axe", 1, [ingredient("cobblestone", 3, { group: "stone" }), ingredient("stick", 2)]),
  recipe("stone_sword", 1, [ingredient("cobblestone", 2, { group: "stone" }), ingredient("stick", 1)]),
  recipe("stone_shovel", 1, [ingredient("cobblestone", 1, { group: "stone" }), ingredient("stick", 2)]),
  recipe("stone_hoe", 1, [ingredient("cobblestone", 2, { group: "stone" }), ingredient("stick", 2)]),
  recipe("torch", 4, [ingredient("coal", 1, { alternatives: ["charcoal"] }), ingredient("stick", 1)], { station: "inventory" }),
  recipe("chest", 1, [ingredient("planks", 8, { group: "planks" })]),
  recipe("shield", 1, [ingredient("iron_ingot", 1), ingredient("planks", 6, { group: "planks" })]),
  recipe("bucket", 1, [ingredient("iron_ingot", 3)]),
  recipe("paper", 3, [ingredient("sugar_cane",3)]),
  recipe("book", 1, [ingredient("paper",3),ingredient("leather",1)],{station:"inventory"}),
  recipe("bookshelf",1,[ingredient("planks",6,{group:"planks"}),ingredient("book",3)]),
  recipe("enchanting_table",1,[ingredient("obsidian",4),ingredient("diamond",2),ingredient("book",1)]),
  recipe("diamond_sword",1,[ingredient("diamond",2),ingredient("stick",1)]),
  recipe("iron_pickaxe", 1, [ingredient("iron_ingot", 3), ingredient("stick", 2)]),
  recipe("iron_axe", 1, [ingredient("iron_ingot", 3), ingredient("stick", 2)]),
  recipe("iron_sword", 1, [ingredient("iron_ingot", 2), ingredient("stick", 1)]),
  recipe("iron_shovel", 1, [ingredient("iron_ingot", 1), ingredient("stick", 2)]),
  recipe("iron_hoe", 1, [ingredient("iron_ingot", 2), ingredient("stick", 2)]),
  recipe("shears", 1, [ingredient("iron_ingot", 2)], { station: "inventory" }),
  recipe("flint_and_steel", 1, [ingredient("iron_ingot", 1), ingredient("flint", 1)], { station: "inventory" }),
  recipe("boat", 1, [ingredient("planks", 5, { group: "planks" })]),
  recipe("bed", 1, [ingredient("wool", 3), ingredient("planks", 3, { group: "planks" })]),
  recipe("door", 3, [ingredient("planks", 6, { group: "planks" })]),
  recipe("ladder", 3, [ingredient("stick", 7)]),
  recipe("bread", 1, [ingredient("wheat", 3)], { station: "inventory" }),
  recipe("charcoal", 1, [ingredient("log", 1, { group: "logs" })], { kind: "smelt", station: "furnace" }),
  recipe("iron_ingot", 1, [ingredient("raw_iron", 1)], { kind: "smelt", station: "furnace" })
]);

const RECIPE_BY_ITEM = new Map(EARLY_GAME_RECIPES.map(entry => [entry.item, entry]));
const GROUPS = Object.freeze({
  planks: new Set(PLANKS),
  logs: new Set(LOGS),
  stone: new Set(STONE),
  coal: new Set(["coal", "charcoal"])
});

function inventoryCounts(inventory) {
  const counts = new Map();
  for (const stack of inventory?.items || []) {
    const item = clean(stack?.name);
    const count = Math.max(0, Number(stack?.count) || 0);
    if (item && count) counts.set(item, (counts.get(item) || 0) + count);
  }
  for (const stack of [inventory?.held, inventory?.offhand, inventory?.armor?.head, inventory?.armor?.chest, inventory?.armor?.legs, inventory?.armor?.feet]) {
    const item = clean(stack?.name);
    const count = Math.max(0, Number(stack?.count) || 0);
    if (item && count) counts.set(item, (counts.get(item) || 0) + count);
  }
  return counts;
}

function groupMembers(group, item) {
  if (GROUPS[group]) return GROUPS[group];
  return new Set([clean(item)]);
}

function availableFor(counts, item, group, alternatives = []) {
  const members = new Set([...groupMembers(group, item), clean(item), ...alternatives.map(clean)]);
  return [...members].reduce((sum, name) => sum + (counts.get(name) || 0), 0);
}

function consume(counts, item, amount, group, alternatives = []) {
  let remaining = amount;
  const members = [...new Set([...groupMembers(group, item), clean(item), ...alternatives.map(clean)])];
  for (const name of members) {
    const taken = Math.min(remaining, counts.get(name) || 0);
    if (taken) counts.set(name, counts.get(name) - taken);
    remaining -= taken;
    if (!remaining) break;
  }
  return amount - remaining;
}

function add(counts, item, amount) {
  if (amount > 0) counts.set(clean(item), (counts.get(clean(item)) || 0) + amount);
}

function recipeNeeds(recipeEntry, crafts) {
  return recipeEntry.inputs.map(input => ({
    ...input,
    item: clean(input.item),
    count: Math.max(0, Number(input.count) || 0) * crafts,
    alternatives: (input.alternatives || []).map(clean)
  }));
}

/** Return the recipe DAG as JSON-safe nodes and ingredient -> result edges. */
export function buildEarlyGameDAG() {
  const nodes = new Map();
  const edges = [];
  const ensure = (id, kind = "item") => {
    const key = clean(id);
    if (!nodes.has(key)) nodes.set(key, { id: key, kind });
    return key;
  };
  for (const entry of EARLY_GAME_RECIPES) {
    ensure(entry.item, "product");
    for (const input of entry.inputs) {
      const from = ensure(input.group || input.item, input.group ? "resource_group" : "item");
      edges.push({ from, to: entry.item, count: input.count, alternatives: input.alternatives || [] });
    }
    if (entry.station && entry.station !== "inventory") {
      const station = ensure(entry.station, "station");
      edges.push({ from: station, to: entry.item, count: 1, kind: "station" });
    }
  }
  return { nodes: [...nodes.values()], edges };
}

function createPlanner(inventory) {
  const counts = inventoryCounts(inventory);
  const active = new Set();
  const missing = new Map();

  const recordMissing = (item, need, available, reason = "resource") => {
    const key = clean(item);
    const deficit = Math.max(0, need - available);
    if (!deficit) return;
    const current = missing.get(key) || { item: key, need: 0, available: 0, missing: 0, reason };
    current.need += need; current.available += available; current.missing += deficit;
    missing.set(key, current);
  };

  const planNode = (target, requested, depth = 0) => {
    const item = clean(target);
    const want = Math.max(0, Math.ceil(Number(requested) || 0));
    if (!want) return { type: "item", item, requested: 0, provided: 0, missing: 0, children: [] };
    const direct = Math.min(want, counts.get(item) || 0);
    if (direct) counts.set(item, counts.get(item) - direct);
    const remaining = want - direct;
    if (!remaining) return { type: "inventory", item, requested: want, provided: direct, missing: 0, children: [] };
    const entry = RECIPE_BY_ITEM.get(item);
    if (!entry || depth > 32 || active.has(item)) {
      recordMissing(item, remaining, direct, entry ? "cycle" : "raw_resource");
      return { type: "resource", item, requested: want, provided: direct, missing: remaining, children: [] };
    }
    active.add(item);
    const crafts = Math.ceil(remaining / entry.output);
    const children = [];
    if (entry.station && entry.station !== "inventory" && !(counts.get(entry.station) > 0)) {
      const station = planNode(entry.station, 1, depth + 1);
      children.push(station);
      if (!station.missing) add(counts, entry.station, 1);
    } else if (entry.station && entry.station !== "inventory") {
      children.push({ type: "inventory", item: entry.station, requested: 1, provided: 1, missing: 0, children: [] });
    }
    for (const input of recipeNeeds(entry, crafts)) {
      const before = availableFor(counts, input.item, input.group, input.alternatives);
      const child = planInput(input, depth + 1);
      child.availableBefore = before;
      children.push(child);
    }
    const produced = crafts * entry.output;
    const complete = children.every(child => !child.missing);
    const used = complete ? Math.min(remaining, produced) : 0;
    if (complete) {
      add(counts, item, produced);
      consume(counts, item, used);
    }
    active.delete(item);
    return {
      type: entry.kind === "smelt" ? "smelt" : "craft",
      item, requested: want, provided: direct + used, missing: complete ? Math.max(0, remaining - used) : remaining,
      crafts, outputPerCraft: entry.output, station: entry.station, children,
      recipe: { item: entry.item, kind: entry.kind, station: entry.station, inputs: recipeNeeds(entry, 1) }
    };
  };

  const planInput = (input, depth) => {
    const alternatives = [input.item, ...(input.alternatives || [])].map(clean);
    const direct = availableFor(counts, input.item, input.group, input.alternatives);
    if (direct >= input.count) {
      const consumed = consume(counts, input.item, input.count, input.group, input.alternatives);
      return { type: "inventory", item: input.item, requested: input.count, provided: consumed, missing: 0, alternatives: input.alternatives || [], group: input.group, children: [] };
    }
    // Prefer an already available alternative before producing the canonical item.
    const consumed = consume(counts, input.item, input.count, input.group, input.alternatives);
    const remaining = input.count - consumed;
    const candidate = alternatives.find(name => RECIPE_BY_ITEM.has(name)) || input.item;
    const child = planNode(candidate, remaining, depth);
    child.item = input.item;
    child.alternatives = input.alternatives || [];
    child.group = input.group;
    return child;
  };

  return { planNode, missing, counts };
}

/**
 * Expand one target into a tree and calculate the net resource deficit.
 * The planner consumes inventory as it walks siblings, so shared planks/sticks
 * are counted once instead of being independently double-counted.
 */
export function analyzeCraftingPlan(item, count = 1, inventory = {}) {
  const target = clean(item);
  const requested = Math.max(1, Math.ceil(Number(count) || 1));
  const planner = createPlanner(inventory);
  const tree = planner.planNode(target, requested);
  const recipeEntry = RECIPE_BY_ITEM.get(target) || null;
  return {
    schemaVersion: 1,
    item: target,
    requested,
    known: Boolean(recipeEntry),
    ok: tree.missing === 0 && planner.missing.size === 0,
    available: tree.provided,
    missing: [...planner.missing.values()].filter(entry => entry.missing > 0),
    tree,
    recipe: recipeEntry ? { ...recipeEntry, inputs: recipeNeeds(recipeEntry, 1) } : null
  };
}

export const DEFAULT_EARLY_GAME_TARGETS = Object.freeze([
  { item: "crafting_table", count: 1 },
  { item: "wooden_pickaxe", count: 1 },
  { item: "stone_pickaxe", count: 1 },
  { item: "furnace", count: 1 },
  { item: "torch", count: 16 },
  { item: "chest", count: 1 },
  { item: "shield", count: 1 },
  { item: "bucket", count: 1 }
]);

/** Build the compact context object supplied to Strategy/Distribution. */
export function buildEarlyGameCraftingSnapshot(inventory, targets = DEFAULT_EARLY_GAME_TARGETS) {
  const analyses = targets.slice(0, 16).map(target => analyzeCraftingPlan(target.item, target.count, inventory));
  return {
    schemaVersion: 1,
    scope: "early_game",
    dag: buildEarlyGameDAG(),
    targets: analyses.map(result => ({
      item: result.item, requested: result.requested, known: result.known, ok: result.ok,
      missing: result.missing, recipe: result.recipe,
      tree: result.tree
    }))
  };
}

export function getEarlyGameRecipe(item) {
  return RECIPE_BY_ITEM.get(clean(item)) || null;
}

export function inventoryItemCounts(inventory) {
  return Object.fromEntries(inventoryCounts(inventory));
}

export { PLANKS, LOGS, STONE, clean as normalizeCraftingItem };
