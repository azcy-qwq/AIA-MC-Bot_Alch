import { EARLY_GAME_RECIPES } from "./crafting-tree.js";

// Keep this map in the shape consumed by the action preflight while deriving
// it from the same recipe source used for the planner and the LLM context.
const RECIPES = Object.fromEntries(EARLY_GAME_RECIPES
  .filter(recipe => recipe.kind === "craft")
  .map(recipe => [recipe.item, recipe.inputs.map(input => ({
    item: input.item,
    count: input.count,
    alternatives: input.alternatives,
    group: input.group
  }))]));
// Preserve the existing preflight coverage outside the early-game planning set.
RECIPES.diamond_pickaxe = [{ item: "diamond", count: 3 }, { item: "stick", count: 2 }];
const OUTPUTS_PER_CRAFT = Object.fromEntries(EARLY_GAME_RECIPES
  .filter(recipe => recipe.kind === "craft" && recipe.output > 1)
  .map(recipe => [recipe.item, recipe.output]));

function inventoryCounts(inventory) {
  const counts = new Map();
  for (const item of inventory?.items || []) {
    const name = String(item?.name || "").replace(/^minecraft:/i, "");
    const count = Math.max(0, Number(item?.count) || 0);
    if (name && count) counts.set(name, (counts.get(name) || 0) + count);
  }
  return counts;
}

export function checkCraftRequirements(inventory, item, count = 1, explicitRequirements) {
  const normalizedItem = String(item || "").replace(/^minecraft:/i, "");
  // Model-provided requirements may describe unknown recipes, but must never
  // override a known recipe and accidentally disable its material preflight.
  const requirements = RECIPES[normalizedItem] || explicitRequirements;
  if (!requirements) return { known: false, ok: true, missing: [] };
  const counts = inventoryCounts(inventory);
  const requested = Math.max(1, Math.floor(Number(count) || 1));
  const crafts = Math.ceil(requested / (OUTPUTS_PER_CRAFT[normalizedItem] || 1));
  const missing = requirements.map(requirement => {
    const needed = Number(requirement.count) * crafts;
    const names = [requirement.item, ...(requirement.alternatives || [])].map(name => String(name).replace(/^minecraft:/i, ""));
    const available = requirement.group === "planks"
      ? [...counts.entries()].filter(([name]) => /_planks$/.test(name)).reduce((sum, [, value]) => sum + value, 0)
      : requirement.group === "stone"
        ? [...counts.entries()].filter(([name]) => ["cobblestone", "cobbled_deepslate", "blackstone"].includes(name)).reduce((sum, [, value]) => sum + value, 0)
        : names.reduce((sum, name) => sum + (counts.get(name) || 0), 0);
    return available < needed ? { item: requirement.item, need: needed, available } : null;
  }).filter(Boolean);
  return { known: true, ok: missing.length === 0, missing, requirements, requested, crafts, outputPerCraft: OUTPUTS_PER_CRAFT[normalizedItem] || 1 };
}

export { RECIPES };
