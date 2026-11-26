export const EARLY_SURVIVAL_FLOW = [
  { id: "starter-wood", title: "起步木料", target: "挖 8 个木头" },
  { id: "wooden-tools", title: "工作台与木工具", target: "工作台落地后制作木棍、木镐" },
  { id: "stone-tools", title: "石制工具", target: "挖 6 个石头，制作石斧和石镐" },
  { id: "supplies", title: "原木与食物", target: "背包达到 32 个原木；用石斧取得 4 块肉，羊毛尽量收集" },
  { id: "descent", title: "斜向下矿道", target: "安全斜向下挖掘，进入地下" },
  { id: "underground-base", title: "临时地下基地", target: "开凿 5×5、两格高空间，补齐地板，放工作台、熔炉和箱子" },
  { id: "coal-level", title: "Y=40 煤层", target: "在 Y=40 附近水平鱼骨，按燃料需求采煤" },
  { id: "iron-level", title: "Y=10 铁层", target: "在 Y=10 附近水平鱼骨采铁" },
  { id: "iron-kit", title: "铁制装备", target: "先铁镐、盾牌，再铁剑和其他铁甲" },
  { id: "deep-descent", title: "Y=-55 深层矿道", target: "下降至 Y=-55，避水和岩浆，遇可达矿洞先探索再续原矿道" },
  { id: "diamond-resources", title: "钻石、金与青金石", target: "采矿基础需求31钻，扣除已制护甲、镐、剑、附魔台；顺采金和青金石" },
  { id: "expanded-base", title: "扩建与钻石装备", target: "扩建地下据点，铁桶、钻石工具与全甲；尽量弓弩并尝试有水有光的农田、甘蔗" },
  { id: "obsidian-enchanting", title: "附魔台与地狱门", target: "获取黑曜石，建附魔台和门；本轮不进入下界" },
  { id: "enchanting", title: "装备附魔（路线可选）", target: "钻石镐→武器；当前附魔专项继续完成四件钻甲", optional: true }
];

function inventoryCounts(inventory) {
  const result = new Map();
  const slots = new Set();
  const add = item => {
    if (!item || typeof item !== "object") return;
    if (Number.isInteger(item.slot)) { if (slots.has(item.slot)) return; slots.add(item.slot); }
    const name = String(item.name || "").replace(/^minecraft:/, "");
    if (name) result.set(name, (result.get(name) || 0) + Number(item.count || 1));
  };
  for (const item of inventory?.items || []) add(item);
  add(inventory?.held);
  add(inventory?.offhand);
  for (const item of Object.values(inventory?.armor || {})) add(item);
  return result;
}

export function estimateEarlySurvivalProgress({ environment = {}, nativeState = null, task = null, progressLedger = null } = {}) {
  const items = inventoryCounts(environment.inventory);
  const count = item => items.get(item) || 0;
  const tiers = ["wooden", "stone", "iron", "diamond", "netherite"];
  const hasTier = (kind, minimum) => [...items.keys()].some(item => {
    const match = item.match(/^(wooden|stone|iron|golden|diamond|netherite)_(.+)$/);
    if (!match || match[2] !== kind || match[1] === "golden") return false;
    return tiers.indexOf(match[1]) >= tiers.indexOf(minimum);
  });
  const logs = [...items].filter(([item]) => item.endsWith("_log") || item.endsWith("_wood")).reduce((sum, [, n]) => sum + n, 0);
  const planks = [...items].filter(([item]) => item.endsWith("_planks")).reduce((sum, [, n]) => sum + n, 0);
  const meat = [...items].filter(([item]) => /^(raw_)?(beef|porkchop|chicken|mutton|rabbit|cod|salmon)$/.test(item) || item.startsWith("cooked_")).reduce((sum, [, n]) => sum + n, 0);
  const wool = [...items].filter(([item]) => item.endsWith("_wool")).reduce((sum, [, n]) => sum + n, 0);
  const y = Number(Array.isArray(environment.status?.pos) ? environment.status.pos[1] : NaN);
  const table = count("crafting_table") > 0;
  const woodenPick = hasTier("pickaxe", "wooden");
  const stonePick = hasTier("pickaxe", "stone");
  const stoneAxe = hasTier("axe", "stone");
  const ironPick = hasTier("pickaxe", "iron");
  const shield = count("shield") > 0;
  const sword = hasTier("sword", "iron");
  const armor = ["helmet", "chestplate", "leggings", "boots"].filter(kind => hasTier(kind, "iron")).length;
  const underground = Number.isFinite(y) && y < 60;
  const hasBase = (nativeState?.workareas || []).some(area => area.dimension === (environment.status?.dimension || "overworld"));
  const coal = count("coal") + count("charcoal");
  const iron = count("iron_ingot") + count("raw_iron") + count("iron_ore") + count("deepslate_iron_ore");
  const ownedDiamond = kind => hasTier(kind, "diamond");
  const diamondCosts = { helmet: 5, chestplate: 8, leggings: 7, boots: 4, pickaxe: 3, sword: 2 };
  const tableBuilt = nativeState?.enchantingArea?.status === "ready" && Boolean(nativeState?.enchantingArea?.verifiedAt);
  const diamondCredit = Object.entries(diamondCosts).reduce((sum, [kind, cost]) => sum + (ownedDiamond(kind) ? cost : 0), 0) + (count("enchanting_table") || tableBuilt ? 2 : 0);
  const diamondsMissing = Math.max(0, 31 - diamondCredit - count("diamond"));
  const diamondKit = ["helmet", "chestplate", "leggings", "boots", "pickaxe", "sword"].every(ownedDiamond);
  const reachedDeep = y <= -55 || Object.values(nativeState?.fishboneRoutes || {}).some(lane => lane?.mainStep > 0 && lane?.dimension === (environment.status?.dimension || "overworld") && lane?.origin?.[1] <= -55);
  const bucket = count("bucket") + count("water_bucket") + count("lava_bucket") > 0;
  const enchanted = kind => [...(environment.inventory?.items || []), ...Object.values(environment.inventory?.armor || {})].some(item => item && /^(diamond|netherite)_/.test(item.name || "") && item.name.endsWith("_" + kind) && Array.isArray(item.enchantments) && item.enchantments.length > 0);
  const portalBuilt = Boolean(nativeState?.portal?.verified);
  let done = [
    logs >= 8 || table || woodenPick,
    woodenPick,
    stonePick && stoneAxe,
    (logs >= 32 && meat >= 4) || underground,
    underground,
    hasBase,
    (coal > 0 && Number.isFinite(y) && y <= 42) || (Number.isFinite(y) && y < 25),
    (iron > 0 && Number.isFinite(y) && y <= 15) || ironPick,
    ironPick && shield && sword && armor >= 2,
    reachedDeep,
    diamondsMissing === 0,
    hasBase && bucket && diamondKit,
    tableBuilt && portalBuilt,
    enchanted("pickaxe") && enchanted("sword")
  ];
  if (underground) for (let index = 0; index <= 4; index++) done[index] = true;
  // Advanced equipment is evidence of earlier tool stages even after coal
  // has been spent or the bot has returned to the surface for supplies.
  if (ownedDiamond("pickaxe") && armor >= 2) for (let index = 0; index <= 8; index++) if (index !== 5 || hasBase) done[index] = true;
  // Progress is monotonic while the character is alive. Items may be placed
  // in a base chest or replaced by a higher tier, so the current snapshot is
  // not allowed to erase an already verified phase. Runtime clears this
  // ledger only after a real death event.
  const observedDone = [...done];
  const remembered = new Set(Array.isArray(progressLedger?.completed) ? progressLedger.completed.map(Number).filter(Number.isInteger) : []);
  done = done.map((value, index) => value || remembered.has(index));
  let currentIndex = done.findIndex(value => !value);
  if (currentIndex < 0) currentIndex = done.length - 1;
  const taskText = (task?.title || "") + " " + (task?.goal || "") + " " + (task?.action?.type || "");
  const taskHints = [
    /原木|木头|chop_tree/.test(taskText) && !woodenPick,
    /工作台|木镐|木棍|craft/.test(taskText) && !stonePick,
    /石头|石斧|石镐|stone/.test(taskText) && !stonePick,
    /肉|羊毛|原木|食物/.test(taskText) && !underground,
    /下矿|斜向下|staircase_down|descend/.test(taskText) && !underground,
    /据点|基地|工作区|build_workarea|build_base/.test(taskText) && !hasBase,
    /煤|coal/.test(taskText) && !(Number.isFinite(y) && y < 25),
    /铁矿|iron_ore|鱼骨/.test(taskText) && !ironPick,
    /铁镐|盾牌|铁剑|铁甲|装备/.test(taskText) && !(ironPick && shield && sword)
  ];
  const hinted = taskHints.findIndex(Boolean);
  if (hinted >= 0 && hinted >= currentIndex - 1) currentIndex = hinted;
  const basis = [
    logs + " 个原木",
    "工作台" + (table ? "在背包中" : woodenPick ? "推定已使用" : "未确认") + "，木镐" + (woodenPick ? "已确认" : "未确认"),
    "石镐" + (stonePick ? "已确认" : "未确认") + "，石斧" + (stoneAxe ? "已确认" : "未确认"),
    logs + " 原木、" + meat + " 食物、" + wool + " 羊毛；羊毛为可选目标",
    Number.isFinite(y) ? "当前 Y=" + y.toFixed(1) : "等待坐标",
    hasBase ? "已记录基地工作区" : "尚无基地工作区记录",
    coal + " 煤/木炭，当前 Y=" + (Number.isFinite(y) ? y.toFixed(1) : "未知"),
    iron + " 铁矿/粗铁/铁锭，当前 Y=" + (Number.isFinite(y) ? y.toFixed(1) : "未知"),
    "铁镐" + (ironPick ? "✓" : "—") + "，盾牌" + (shield ? "✓" : "—") + "，铁剑" + (sword ? "✓" : "—") + "，铁甲" + armor + "/4",
    reachedDeep ? "当前或已施工矿道确认到达 Y≤-55" : "尚未确认到达 Y=-55",
    "散钻" + count("diamond") + "，当前成品折算" + diamondCredit + "（护甲" + ["helmet","chestplate","leggings","boots"].reduce((sum,kind)=>sum+(ownedDiamond(kind)?diamondCosts[kind]:0),0) + "/24、镐" + (ownedDiamond("pickaxe")?3:0) + "/3、剑" + (ownedDiamond("sword")?2:0) + "/2、台" + (count("enchanting_table")||tableBuilt?2:0) + "/2），基础还缺" + diamondsMissing + "钻；只计当前持有/穿戴及已验证设施",
    "地下据点" + (hasBase ? "✓" : "—") + "，铁桶" + (bucket ? "✓" : "—") + "，钻石装备" + (diamondKit ? "齐全" : "待补齐") + "；弓弩/农田为尝试目标",
    "附魔台" + (tableBuilt ? "已验证" : "未验证") + "，地狱门" + (portalBuilt ? "已验证" : "未验证") + "，背包黑曜石" + count("obsidian"),
    "镐附魔" + (enchanted("pickaxe") ? "✓" : "—") + "，武器附魔" + (enchanted("sword") ? "✓" : "—")
  ];
  return {
    currentIndex,
    diamondBudget: { total: 31, craftedCredit: diamondCredit, loose: count("diamond"), missing: diamondsMissing },
    estimated: true,
    phases: EARLY_SURVIVAL_FLOW.map((phase, index) => {
      const historical = remembered.has(index) && !observedDone[index];
      return {
        ...phase,
        status: done[index] ? "done" : index === currentIndex ? "active" : "upcoming",
        progressSource: historical ? "history" : observedDone[index] ? "current" : "pending",
        evidence: historical ? `历史进度已确认；当前观察：${basis[index]}` : basis[index]
      };
    })
  };
}
