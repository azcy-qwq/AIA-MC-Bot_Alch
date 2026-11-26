import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRuntime } from "../src/runtime.js";
import { EventBus } from "../src/core/events.js";

const root = "data/local-regression";
const apiConfig = JSON.parse(await readFile("mc-agent-api/config.json", "utf8"));
const eventsPath = `${root}/events.jsonl`;
await mkdir(root, { recursive: true });

const config = {
  api: { baseUrl: "http://127.0.0.1:18900/api/v1", username: "Licphel", password: apiConfig.auth.password },
  llm: { baseUrl: "", apiKey: "", model: "" },
  sessionBudget: { sessionFile: `${root}/debug-session.json`, ledgerFile: `${root}/llm-session-budget.json` },
  intervals: { strategyMs: 5000, strategyMinReplanMs: 1000, strategyPrethinkMs: 1000, strategicMs: 60000, strategicMinReplanMs: 60000, reflectionMs: 3600000, reflectionMinMs: 3600000, reflectionDebounceMs: 60000, actionRetryDelayMs: 100, observationMs: 500, tacMs: 250 },
  debug: { enabled: false, host: "127.0.0.1", port: 0 },
  routes: { filePath: `${root}/routes.json` },
  memory: { filePath: `${root}/strategy-memory.json` },
  memoryArchive: { filePath: `${root}/memory-archive.json` },
  distributionState: { filePath: `${root}/distribution-state.json` },
  runtimeState: { filePath: `${root}/runtime-state.json` },
  native: { stateFile: `${root}/native-state.json` },
  timing: { filePath: `${root}/task-timing-model.json`, journalPath: `${root}/task-timing-samples.jsonl` }
};

const counts = snapshot => Object.fromEntries((snapshot?.inventory?.items || []).map(item => [item.name, Number(item.count) || 0]));
const hasAny = (inventory, names) => names.some(name => inventory[name] > 0);
const task = (id, title, action, params = {}) => ({ id, title, goal: title, actions: [{ type: action, params }] });

const provider = {
  async createStrategy() {
    return { mission: "本地新世界早期生存回归", horizon: "本次回归全程", objectives: [{ id: "early", title: "验证早期生存动作链", goal: "从出生点完成木材、工作台、木棍、木镐和石镐材料验证", priority: 100, status: "active", constraints: ["以服务器确认的背包和状态为准"] }], route: ["出生点", "附近树木", "安全工作点"], risks: ["夜间敌对生物", "掉落和导航失败"], principles: ["一阶段一目标", "失败后观察再改变参数"] };
  },
  async createAutomationPlan({ context }) {
    const inventory = Object.fromEntries((context.inventory?.items || []).map(item => [item.name, Number(item.count) || 0]));
    if (!hasAny(inventory, ["oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log", "dark_oak_log", "cherry_log", "mangrove_log", "pale_oak_log"])) return { rationale: "从零采集原木", priorities: ["木材"], tasks: [task("wood", "采集8块原木", "chop_tree", { targetCount: 8, radius: 32, exploreSteps: 8 })] };
    if (!inventory.crafting_table) return { rationale: "原木已入包，制作工作台", priorities: ["工作台"], tasks: [task("table", "制作工作台", "craft", { item: "crafting_table", count: 1 })] };
    if ((inventory.stick || 0) < 8) return { rationale: "工作台已确认，制作木棍", priorities: ["木棍"], tasks: [task("sticks", "制作木棍", "craft", { item: "stick", count: 8 })] };
    if (!inventory.wooden_pickaxe) return { rationale: "木棍已确认，制作木镐", priorities: ["木镐"], tasks: [task("wood-pick", "制作木镐", "craft", { item: "wooden_pickaxe", count: 1 })] };
    if ((inventory.cobblestone || 0) < 6 && (inventory.stone || 0) < 6) return { rationale: "木镐已确认，采集石头材料", priorities: ["石头"], tasks: [task("stone", "采集石头材料", "mine_vein", { types: ["stone", "deepslate"], targetCount: 8 })] };
    if (!inventory.stone_pickaxe) return { rationale: "石头材料已确认，制作石镐", priorities: ["石镐"], tasks: [task("stone-pick", "制作石镐", "craft", { item: "stone_pickaxe", count: 1 })] };
    return { rationale: "早期生存回归目标已完成，停止继续施工", priorities: ["验证完成"], tasks: [] };
  }
};

const events = new EventBus();
const record = async (type, data = {}) => {
  await writeFile(eventsPath, `${JSON.stringify({ at: Date.now(), type, action: data.action, source: data.source, error: data.error?.message || data.error?.code, warning: data.warning?.code, progress: data.progress, result: data.result })}\n`, { encoding: "utf8", flag: "a" });
};
for (const type of ["started", "action-start", "action-progress", "action-end", "action-error", "action-warning", "task-complete", "task-error", "distribution-output", "distribution-error", "strategic-output", "strategic-error", "runtime-warning", "death", "respawned", "runtime-game-disconnected"]) events.on(type, data => { record(type, data).catch(() => {}); if (["action-error", "action-warning", "death", "runtime-game-disconnected"].includes(type)) console.log(`[${type}]`, JSON.stringify(data?.error || data?.warning || data)); });

const runtime = createRuntime({ config, strategyProvider: provider, eventBus: events });
const deadline = Date.now() + 8 * 60 * 1000;
try {
  await runtime.start();
  console.log("REGRESSION_STARTED");
  while (Date.now() < deadline) {
    const snapshot = runtime.worldModel.latest;
    const inventory = counts(snapshot);
    if (inventory.stone_pickaxe > 0) {
      if (runtime.executor.busy || runtime.executor.queueLength) {
        await new Promise(resolve => {
          const off = events.on("native-idle", () => { off(); resolve(); });
          setTimeout(() => { off(); resolve(); }, 30000).unref?.();
        });
      }
      console.log("REGRESSION_TARGET_REACHED", JSON.stringify({ pos: snapshot.status?.pos, inventory }));
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  const snapshot = runtime.worldModel.latest;
  console.log("REGRESSION_FINAL", JSON.stringify({ status: snapshot?.status, inventory: counts(snapshot), execution: runtime.executor.snapshot() }));
} catch (error) {
  console.error("REGRESSION_FAILED", error.stack || error.message);
  process.exitCode = 1;
} finally {
  await runtime.stop({ logout: true }).catch(error => console.error("REGRESSION_STOP_FAILED", error.message));
}
