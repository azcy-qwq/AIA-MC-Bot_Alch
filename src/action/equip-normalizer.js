const EQUIP_SLOTS = new Set(["hand", "off-hand", "head", "torso", "legs", "feet"]);
const SLOT_ALIASES = new Map([
  ["main_hand", "hand"], ["mainhand", "hand"], ["weapon", "hand"], ["held", "hand"],
  ["offhand", "off-hand"], ["off_hand", "off-hand"], ["shield", "off-hand"],
  ["chest", "torso"], ["chestplate", "torso"], ["body", "torso"],
  ["helmet", "head"], ["leggings", "legs"], ["boots", "feet"]
]);

const cleanName = value => String(value || "").trim().replace(/^minecraft:/i, "");
const MAIN_HAND_TOOL = /(?:_(?:sword|axe|pickaxe|shovel|hoe|spear)$|^(?:bow|crossbow|trident|mace|fishing_rod|shears|brush|flint_and_steel)$)/;

function inferredSlot(item) {
  const name = cleanName(item).toLowerCase();
  if (name === "shield") return "off-hand";
  if (/(helmet|_head$|skull$|pumpkin$)/.test(name)) return "head";
  if (/(chestplate|elytra)/.test(name)) return "torso";
  if (/(leggings|_legs$)/.test(name)) return "legs";
  if (/(boots|_feet$)/.test(name)) return "feet";
  return "hand";
}

function findInventoryItem(item, inventory) {
  const stacks = Array.isArray(inventory?.items) ? inventory.items : [];
  const raw = item && typeof item === "object" ? item.name ?? item.item ?? item.slot : item;
  const number = Number(raw);
  if (Number.isInteger(number) && String(raw).trim() !== "") {
    return stacks.find(stack => Number(stack.slot) === number)?.name || null;
  }
  return cleanName(raw);
}

/** Convert common model mistakes into the exact /equip schema. */
export function normalizeEquipParams(params = {}, inventory = null) {
  const itemInput = params.item ?? params.name ?? params.source;
  const item = findInventoryItem(itemInput, inventory);
  if (!item) throw Object.assign(new Error("equip 需要物品名称；不能把背包 slot 编号当作 item"), { code: "invalid_equip_item" });
  const stacks = Array.isArray(inventory?.items) ? inventory.items : [];
  const itemStack = stacks.find(stack => cleanName(stack.name) === item && Number(stack.count ?? 1) > 0);
  if (stacks.length && !itemStack) {
    throw Object.assign(new Error(`背包中没有可装备的 ${item}`), { code: "missing_item", details: { item } });
  }

  const rawSlot = params.slot ?? params.destination ?? params.to;
  const numericDestination = rawSlot !== undefined && /^\d+$/.test(String(rawSlot).trim());
  if (numericDestination && itemStack && Number(rawSlot) !== Number(itemStack.slot)) {
    throw Object.assign(new Error(`equip.slot 不能使用背包槽位 ${String(rawSlot)}；请使用 hand、off-hand、head、torso、legs 或 feet`), { code: "invalid_equip_slot", details: { slot: rawSlot } });
  }
  let slot = numericDestination ? null : SLOT_ALIASES.get(String(rawSlot || "").trim().toLowerCase()) || String(rawSlot || "").trim().toLowerCase();
  if (!slot) slot = inferredSlot(item);
  if (!EQUIP_SLOTS.has(slot)) {
    throw Object.assign(new Error(`equip.slot 必须是 hand、off-hand、head、torso、legs 或 feet，收到 ${String(rawSlot)}`), { code: "invalid_equip_slot", details: { slot: rawSlot } });
  }
  if (slot === "off-hand" && MAIN_HAND_TOOL.test(item.toLowerCase())) {
    throw Object.assign(new Error(`${item} 是主手武器或工具，请使用 hand；不能转到副手来绕过挖掘或攻击错误`), { code: "invalid_equip_slot", details: { item, slot, requiredSlot: "hand" } });
  }
  return { item, slot };
}

export { EQUIP_SLOTS, inferredSlot };
