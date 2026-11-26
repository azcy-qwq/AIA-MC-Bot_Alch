const name = value => String(value || "").replace(/^minecraft:/, "");
export function preNetherReadiness(snapshot = {}) {
  const inv = snapshot.inventory || {}, counts = {};
  // Inventory items already includes equipped hotbar stacks. Armour/offhand
  // may be outside that list; deduplicate by slot when it is provided.
  const seen = new Set();
  for (const stack of [...(inv.items || []), ...Object.values(inv.armor || {}), inv.offhand].filter(Boolean)) {
    if (stack.slot !== undefined && seen.has(stack.slot)) continue;
    if (stack.slot !== undefined) seen.add(stack.slot);
    counts[name(stack.name)] = (counts[name(stack.name)] || 0) + (Number(stack.count) || 1);
  }
  const sum = predicate => Object.entries(counts).filter(([key]) => predicate(key)).reduce((n, [,count]) => n + count, 0);
  const have = (...items) => items.some(item => counts[item] > 0);
  const worn = [inv.armor?.head, inv.armor?.chest || inv.armor?.torso, inv.armor?.legs, inv.armor?.feet];
  const parts = ["helmet", "chestplate", "leggings", "boots"];
  const armorReady = worn.every((stack, index) => new RegExp(`^(iron|diamond|netherite|golden)_${parts[index]}$`).test(name(stack?.name)))
    && worn.filter(stack => name(stack?.name).startsWith("golden_")).length <= 1;
  const checks = [
    { id: "health", title: "生命至少18、食物至少16", ok: snapshot.status?.health >= 18 && snapshot.status?.food >= 16 },
    { id: "pickaxe", title: "铁镐或更高级镐", ok: have("iron_pickaxe", "diamond_pickaxe", "netherite_pickaxe") },
    { id: "weapon", title: "铁剑或更高级武器", ok: have("iron_sword", "diamond_sword", "netherite_sword", "iron_axe", "diamond_axe") },
    { id: "shield", title: "副手已装备盾牌", ok: name(inv.offhand?.name) === "shield" },
    { id: "armor", title: "已穿戴完整铁级以上护甲（最多一件金甲替换）", ok: armorReady },
    { id: "water", title: "水桶（主世界施工和灭火用，下界不能放水）", ok: have("water_bucket") },
    { id: "ignition", title: "打火石", ok: have("flint_and_steel") },
    { id: "food", title: "至少16份成品食物", ok: sum(key => /^(?:bread|cooked_.+|baked_potato|golden_carrot)$/.test(key)) >= 16 },
    { id: "blocks", title: "至少64个不易燃建筑方块", ok: sum(key => ["cobblestone", "stone", "cobbled_deepslate", "deepslate"].includes(key)) >= 64 },
    { id: "light", title: "至少32根火把", ok: (counts.torch || 0) >= 32 },
    { id: "wood", title: "16个木板或4根原木", ok: sum(key => /_planks$/.test(key)) >= 16 || sum(key => /_(log|stem)$/.test(key)) >= 4 },
    { id: "portal", title: "至少10块黑曜石；或已验证的安全铸门方案", ok: (counts.obsidian || 0) >= 10 || (snapshot.portalPreparation?.verified === true && snapshot.portalPreparation?.waterSourceVerified === true && snapshot.portalPreparation?.lavaSourceVerified === true && snapshot.portalPreparation?.retreatVerified === true) }
  ];
  return { goal: "完成进入下界之前的准备，准备完成后留在主世界等待用户", enterNether: false, ready: checks.every(check => check.ok), checks, missing: checks.filter(check => !check.ok).map(check => check.title), notes: ["先建立可往返的安全矿道和修整点，再采铁、熔炼、装备和准备传送门。", "不得为囤积而继续挖原木和普通石头；按缺口采集。", "水桶和打火石对方块使用走 interact；熔炼走熔炉 window_act，不能用 craft 合成铁锭。", "准备目标不等于允许进入下界；完成后保持在主世界。"] };
}
