import { summarizeEnvironment } from "../core/environment-summary.js";
import { analyzeCraftingPlan } from "../action/crafting-tree.js";
import { estimateEarlySurvivalProgress } from "../strategy/early-survival-flow.js";

const text = (value, limit = 300) => String(value || "").slice(0, limit);
const round = value => Number.isFinite(value) ? Math.round(value * 10) / 10 : value;
const distance = (a, b) => Array.isArray(a) && Array.isArray(b) ? Math.hypot(...a.map((n, i) => n - b[i])) : Infinity;
const taskBrief = task => task ? { id: task.id, title: text(task.title, 140), goal: text(task.goal), actions: (task.actions || []).slice(0, 8).map(action => ({ type: action.type, params: action.params || {} })) } : null;

export function canContinueWithoutHealing(status, nativeState) {
  const deferred = nativeState?.combat?.healingDeferred;
  return Boolean(deferred && status?.alive && deferred.dimension === (status.dimension || "overworld")
    && status.health >= deferred.health && status.food <= deferred.food);
}

export function compactDistributionPlan(plan) {
  return plan ? { planId: plan.planId, rationale: text(plan.rationale), tasks: (plan.tasks || []).slice(0, 8).map(taskBrief) } : null;
}

function nativeContext(state, position, dimension, laneId) {
  state ||= {};
  const sameDimension = value => value && typeof value === "object" && (!value.dimension || value.dimension === dimension);
  const usedLaneIds = new Set(Object.entries(state.fishboneRoutes || {}).map(([key, lane]) => String(lane?.laneId ?? key.replace(/^fishbone:/, ""))));
  let nextUnusedLaneId = 1;for (const id of usedLaneIds) if (/^\d+$/.test(id) && Number.isSafeInteger(Number(id))) nextUnusedLaneId = Math.max(nextUnusedLaneId, Number(id) + 1);
  const anchors = Object.entries(state.anchors || {}).filter(([, value]) => sameDimension(value))
    .sort(([an, a], [bn, b]) => (distance(a.pos, position) - (/家|据点|入口/.test(an) ? 16 : 0)) - (distance(b.pos, position) - (/家|据点|入口/.test(bn) ? 16 : 0)))
    .slice(0, 10).map(([name, value]) => ({ name, pos: value.pos, verifiedAt: value.verifiedAt }));
  const lanes = Object.entries(state.fishboneRoutes || {}).filter(([, value]) => sameDimension(value) && (laneId ? String(value.laneId) === String(laneId) : value.phase !== "complete"))
    .sort(([, a], [, b]) => distance(a.lastPos || a.end || a.origin, position) - distance(b.lastPos || b.end || b.origin, position))
    .slice(0, 2).map(([, lane]) => ({ laneId: lane.laneId, phase: lane.phase, origin: lane.origin, end: lane.end, direction: lane.direction, mainStep: lane.mainStep, length: lane.length, mainFinished: lane.mainFinished, mainBoundary: lane.mainBlocked?.pos, blockedBranches: (lane.branches || []).filter(branch => branch.blocked).length, branchLength: lane.branchLength, branchEvery: lane.branchEvery, branchHub: lane.branchHub, branchSign: lane.branchSign, branchStep: lane.branchStep, lastPos: lane.lastPos, provisionalEntry: !lane.mainStep && !lane.mainFinished && !(lane.branches || []).length }));
  const workareas = (state.workareas || []).filter(sameDimension).slice(-4).map(area => ({ name: area.name, min: area.min, max: area.max, entrance: area.entrance, exit: area.exit, facilities: area.facilities }));
  const deferredOres = Object.values(state.deferredOres || {}).filter(sameDimension).sort((a,b)=>distance(a.pos,position)-distance(b.pos,position)).slice(0,6).map(ore=>({type:ore.type,pos:ore.pos,requiredTier:ore.requiredTier,observedAt:ore.observedAt}));
  const surveys=key=>Object.entries(state[key]||{}).filter(([,v])=>sameDimension(v)).sort(([,a],[,b])=>distance(a.lastPos||a.entry,position)-distance(b.lastPos||b.entry,position)).slice(0,3).map(([id,v])=>({id,entry:v.entry,lastPos:v.lastPos,status:v.status,nodes:Object.keys(v.nodes||{}).length,unexplored:Object.values(v.nodes||{}).filter(n=>n.state!=="surveyed_local").length,recentRuns:(v.runs||[]).slice(-2)}));
  const recordedSupplyCaches=Object.values(state.supplyCaches||{}).filter(sameDimension).sort((a,b)=>distance(a.pos,position)-distance(b.pos,position)).slice(0,2).map(v=>({pos:v.pos,recordedContents:v.stored,verifiedAt:v.verifiedAt,requiresRecheck:true}));
  return { anchors, workareas, recordedSupplyCaches, fishboneRoutes: lanes, caveSurveys:surveys("caveSurveys"),resourceSurveys:surveys("resourceSurveys"),enchantingArea:state.enchantingArea,enchantingProgress:state.enchantingProgress,nextUnusedLaneId: String(nextUnusedLaneId), deferredOres, apiCompatibility: state.apiCompatibility || null, death: state.death ? { pos: state.death.pos || state.death.position, dimension: state.death.dimension, at: state.death.at } : null };
}

function relevantMemories(memory, archive, task, position, dimension) {
  const actions = (task?.actions || []).map(action => action.type);
  const entries = [...(memory?.facts || []), ...(archive?.entries || [])].filter(entry => entry.source !== "reflection" && !["lesson", "hint"].includes(entry.kind));
  const score = entry => {
    const detail = entry.detail || entry;
    if (detail.dimension && dimension && detail.dimension !== dimension) return -Infinity;
    const timestamp = entry.lastSeenAt || entry.at || 0;
    const target = detail.target?.pos || detail.target || detail.params?.target;
    const sameAction = actions.some(action => detail.action === action || detail.action?.type === action || entry.tags?.includes(action));
    return (sameAction ? 10 : 0) + (distance(target, position) <= 32 ? 5 : 0) - Math.min(24, (Date.now() - timestamp) / 3600000);
  };
  const seen = new Set();
  return entries.map(entry => ({ entry, score: score(entry) })).filter(item => item.score >= -2).sort((a, b) => b.score - a.score).filter(({ entry }) => {
    const key = entry.key || entry.summary || JSON.stringify(entry.target);if (seen.has(key)) return false;seen.add(key);return true;
  }).slice(0, 6).map(({ entry }) => ({ kind: entry.kind || entry.type, summary: text(entry.summary || entry.message || entry.action, 400), target: entry.detail?.target || entry.target, at: entry.lastSeenAt || entry.at }));
}

function craftReadiness(inventory, phase, task, enchanting=false) {
  const defaults = enchanting?["enchanting_table","bookshelf","diamond_sword"]:phase <= 2 ? ["crafting_table", "stone_pickaxe", "stone_axe"] : phase <= 6 ? ["furnace", "chest", "torch"] : ["iron_pickaxe", "shield", "iron_sword"];
  const requested = new Map(defaults.map(item => [item, item === "torch" ? 16 : 1]));
  for (const action of task?.actions || []) {
    const params = action.params || {};
    if (action.type === "craft" && params.item) requested.set(params.item, Number(params.count) || 1);
    if (action.type === "workshop" && params.mode === "craft") for (const item of params.items || []) requested.set(item.item, Number(item.count) || 1);
    if (action.type === "workshop" && params.mode === "smelt") requested.set("furnace",1);
  }
  return [...requested].slice(-5).map(([item, count]) => {
    const result = analyzeCraftingPlan(item, count, inventory);const processing = new Map();
    const visit = node => { for (const child of node.children || []) visit(child);if (["craft", "smelt"].includes(node.type)) processing.set(node.item, { item: node.item, kind: node.type, station: node.station }); };
    visit(result.tree);
    return { item, count, ok: result.ok, missing: result.missing, processing: [...processing.values()] };
  });
}

/** Select decision inputs; full world, route geometry and recipe DAG stay local. */
export function buildDistributionContext({ snapshot = {}, strategicPlan, execution = {}, nativeState, queuedTasks = [], scriptCatalog, activeTask, failedTask, continuityMode, continuationProgress, debugHints = [], memory, memoryArchive, lastFailure, inventoryBrief, progressLedger = null }) {
  const summary = summarizeEnvironment(snapshot, "action"), status = summary.status;
  const phase = estimateEarlySurvivalProgress({ environment: snapshot, nativeState, progressLedger: typeof progressLedger === "function" ? progressLedger() : progressLedger });
  const laneId = activeTask?.actions?.find(action => action.type === "fishbone_mine")?.params?.laneId;
  const inventory = new Map();for (const item of snapshot.inventory?.items || []) inventory.set(item.name, (inventory.get(item.name) || 0) + Number(item.count || 0));
  const visibleBlockEntries = Object.entries(snapshot.blocks?.blocks || {}).filter(([name]) => /_ore$|_log$|water|lava|gravel|sand$|crafting_table|furnace|chest|sugar_cane|obsidian|bookshelf|enchanting_table/.test(name));
  const blocks = visibleBlockEntries
    .sort(([, a], [, b]) => Number(a.dist || 0) - Number(b.dist || 0)).slice(0, 12).map(([name, block]) => ({ name, nearest: block.nearest, distance: round(block.dist) }));
  // Facilities are decision-critical even when many terrain classes are
  // closer. Keep them in a separate bounded list so Distribution can reuse
  // an existing enchanting table/bookshelf instead of crafting duplicates.
  const summaryFacilities = visibleBlockEntries.filter(([name]) => /^(enchanting_table|bookshelf|crafting_table|furnace|chest)$/.test(name))
    .map(([name, block]) => ({ name, nearest: block.nearest, distance: round(block.dist) }));
  const targetedFacilities = (snapshot.facilities?.blocks || []).filter(block => block && block.name && Array.isArray(block.pos))
    .map(block => ({ name: block.name, nearest: block.pos, distance: round(block.dist) }));
  const nearbyFacilities = [...summaryFacilities, ...targetedFacilities]
    .sort((a, b) => Number(a.distance || 0) - Number(b.distance || 0))
    .filter((block, index, list) => index === list.findIndex(other => other.name === block.name && JSON.stringify(other.nearest) === JSON.stringify(block.nearest)))
    .slice(0, 8);
  const space = summary.spatial;
  const miningFocus = Number(status.position?.[1]) <= -20 && phase.diamondBudget.missing > 0 && activeTask?.actions?.some(action => action.type === "fishbone_mine") && !strategicPlan?.objectives?.some(goal => goal.status === "active" && /建立.*基地|建造.*家|美化|扩建|附魔/.test(goal.title || ""));
  const brief = inventoryBrief ? {
    stone: inventoryBrief.stone, iron: inventoryBrief.iron, coal: inventoryBrief.coal, diamondBudget: inventoryBrief.diamondBudget,
    wood: { logs: Object.values(inventoryBrief.wood?.logs || {}).reduce((sum, value) => sum + Number(value || 0), 0), planks: inventoryBrief.wood?.planks, sticks: inventoryBrief.wood?.sticks }, tools: inventoryBrief.tools
  } : undefined;
  const failure = lastFailure ? { action: lastFailure.action, task: taskBrief(lastFailure.task), error: { code: lastFailure.error?.code, message: text(lastFailure.error?.message), details: lastFailure.error?.details ? text(JSON.stringify(lastFailure.error.details), 600) : undefined }, at: lastFailure.at } : null;
  return {
    layer: "distribution", observedAt: summary.observedAt,
    status: { position: status.position, dimension: status.dimension, health: status.health, food: status.food, oxygen: status.oxygen, xpLevel: snapshot.status?.xp_level, held: snapshot.status?.held?.name || snapshot.inventory?.held?.name || null, offhand: snapshot.status?.offhand?.name || snapshot.inventory?.offhand?.name || null, hazards: status.hazards, day: status.time.day },
    risks: summary.risks,
    healthRecovery: canContinueWithoutHealing(snapshot.status, nativeState) ? "Tac 已结束原地回血等待。继续当前安全任务，有近处补给可顺路获取。" : undefined,
    visibleBlocks: { nearby: blocks, facilities: nearbyFacilities, note: "方块位置不是站立点；数量不作为通路证据" },
    spatial: space ? { origin: space.origin, observedAt: space.observedAt, ownColumn: space.ownColumn, columns: space.columns, slices: space.slices, hazards: space.hazards, legend: space.legend } : null,
    inventory: { items: [...inventory].map(([name, count]) => ({ name, count })), toolDurability: (snapshot.inventory?.items || []).filter(item => /_(pickaxe|axe|sword|shovel|hoe)$/.test(item.name) && Number.isFinite(item.durability_used)).map(item => ({ name: item.name, used: item.durability_used, slot: item.slot, ...(item.enchantments?{enchantments:item.enchantments}:{}) })), armor: Object.fromEntries(Object.entries(snapshot.inventory?.armor || {}).map(([slot, item]) => [slot, item?{name:item.name,enchantments:item.enchantments}:null])), emptySlots: snapshot.inventory?.empty_slots },
    inventoryQuickReference: brief,
    storagePolicy: { fieldDeposits: false, note: "不在矿道或采集途中放箱、自动存矿；存取仅在明确指定的据点箱子进行。旧补给箱内容是历史记录，取用前核实。" },
    strategicPlan: strategicPlan ? { planId: strategicPlan.planId, mission: text(strategicPlan.mission, 500), objectives: (strategicPlan.objectives || []).filter(goal => goal.status !== "done").slice(0, 3).map(goal => ({ id: goal.id, title: goal.title, goal: text(goal.goal), constraints: (goal.constraints || []).slice(0, 4) })), risks: (strategicPlan.risks || []).slice(0, 4) } : null,
    earlySurvivalFlow: { current: phase.phases[phase.currentIndex], next: phase.phases.slice(phase.currentIndex + 1).filter(stage => stage.status !== "done").slice(0, 2), diamondBudget: phase.diamondBudget },
    nativeState: nativeContext(nativeState, status.position, status.dimension, laneId),
    queuedTasks: queuedTasks.slice(0, 8), scriptCatalog,
    execution: { currentAction: execution.currentAction, completedActions: execution.completedActions, workProgress: execution.workProgress ? { phase: execution.workProgress.phase, completed: execution.workProgress.completed, total: execution.workProgress.total, laneId: execution.workProgress.laneId } : null },
    taskContinuity: { mode: continuityMode, activeTask: taskBrief(activeTask) }, failedTask: taskBrief(failedTask),
    continuationProgress: continuationProgress ? { laneId: continuationProgress.laneId, phase: continuationProgress.phase, end: continuationProgress.end, hub: continuationProgress.hub, updatedAt: continuationProgress.updatedAt } : null,
    debugHints: debugHints.slice(-5).map(hint => ({ text: text(hint.text, 500), at: hint.at })),
    memory: { facts: relevantMemories(memory, memoryArchive, activeTask, status.position, status.dimension) },
    recentActionFailure: failure, craftReadiness: craftReadiness(snapshot.inventory, phase.currentIndex, activeTask,/附魔/.test(strategicPlan?.mission||"")),
    mission: snapshot.mission ? { goal: snapshot.mission.goal, ready: snapshot.mission.ready, missing: snapshot.mission.missing } : undefined,
    control: { forbiddenActions: miningFocus ? ["build_base", "build_workarea"] : [], discardableItems: ["cobblestone", "cobbled_deepslate", "stone", "deepslate", "andesite", "granite", "diorite", "tuff", "smooth_basalt", "basalt", "blackstone", "calcite", "dirt", "gravel", "sand", "red_sand", "leaf_litter", "wildflowers"], laneSelection: "继续工作使用原laneId；确需新矿道时使用nativeState.nextUnusedLaneId，其他旧编号可能对应远处旧矿道。discard_items仅允许discardableItems内的普通石料泥沙及落叶杂花，红石等矿物保留随身；存取必须明确指定据点箱子，禁止随地放箱存矿。", note: miningFocus ? "当前以深层采钻为主，不为清槽另建基地或工作区，只清理允许的普通石料；存矿须安排返回据点" : "" }
  };
}
