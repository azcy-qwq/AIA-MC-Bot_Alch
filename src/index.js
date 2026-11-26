import { createRuntime } from "./runtime.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

export { createRuntime } from "./runtime.js";
export { MultiBotRuntime, createMultiBotRuntime } from "./multi-bot.js";
export { loadConfig } from "./config.js";
export { WorldModel } from "./core/world-model.js";
export { StrategyEngine } from "./strategy/strategy-engine.js";
export { StrategicEngine } from "./strategy/strategic-engine.js";
export { ActionExecutor, PlanRunner } from "./action/action-executor.js";
export { TacController } from "./tac/tac-controller.js";
export { MemoryArchive } from "./memory/memory-archive.js";
export { DeathLootRecovery } from "./recovery/death-loot-recovery.js";
export { normalizeEquipParams } from "./action/equip-normalizer.js";
export { EARLY_GAME_RECIPES, DEFAULT_EARLY_GAME_TARGETS, buildEarlyGameDAG, buildEarlyGameCraftingSnapshot, analyzeCraftingPlan, getEarlyGameRecipe, inventoryItemCounts } from "./action/crafting-tree.js";
export { createSkills, PveCombatScript, MlgWaterScript, FishboneMiningScript, VeinMiningScript, NavigationSkill, TerrainFlattenSkill } from "./skills/index.js";

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const runtime = createRuntime();
  runtime.events.on("error", error => console.error("[runtime]", error));
  runtime.events.on("emergency", event => console.warn("[tac]", event.kind));
  process.once("SIGINT", () => runtime.stop().finally(() => process.exit(0)));
  process.once("SIGTERM", () => runtime.stop().finally(() => process.exit(0)));
  runtime.start().catch(error => {
    console.error("[runtime] failed to start:", error.message);
    process.exitCode = 1;
  });
}
