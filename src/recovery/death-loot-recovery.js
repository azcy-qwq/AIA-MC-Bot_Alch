import { EventBus } from "../core/events.js";

const floorPos = pos => Array.isArray(pos) && pos.length >= 3 ? pos.slice(0, 3).map(Number).map(Math.floor) : null;
const countItem = (inventory, name) => (inventory?.items || []).filter(item => item.name === name).reduce((sum, item) => sum + Number(item.count || 0), 0);
const FLUIDS = new Set(["water", "flowing_water", "lava", "flowing_lava", "bubble_column"]);
const EMPTY = new Set(["air", "cave_air", "void_air"]);

function deathPosition(deathEvent, status) {
  return floorPos(deathEvent?.dropped_items_at) || floorPos(deathEvent?.pos) || floorPos(status?.last_death?.pos);
}

function loadout(inventory = {}) {
  const targets = [];
  if (inventory.held?.name) targets.push({ item: inventory.held.name, slot: "hand" });
  if (inventory.offhand?.name) targets.push({ item: inventory.offhand.name, slot: "off-hand" });
  const armor = inventory.armor || {};
  const armorSlots = { head: "head", helmet: "head", chest: "torso", torso: "torso", legs: "legs", feet: "feet" };
  for (const [name, slot] of Object.entries(armorSlots)) if (armor[name]?.name) targets.push({ item: armor[name].name, slot });
  return targets.filter((target, index, all) => all.findIndex(other => other.slot === target.slot) === index);
}

export class DeathLootRecovery {
  constructor({ api, executor, worldModel, eventBus = new EventBus(), logger = console } = {}) {
    this.api = api;
    this.executor = executor;
    this.worldModel = worldModel;
    this.events = eventBus;
    this.logger = logger;
  }

  async #safeTarget(candidate) {
    const pos = floorPos(candidate);
    if (!pos || !this.api.getBlock) return pos;
    try {
      const [feet, support, head] = await Promise.all([
        this.api.getBlock({ pos }),
        this.api.getBlock({ pos: [pos[0], pos[1] - 1, pos[2]] }),
        this.api.getBlock({ pos: [pos[0], pos[1] + 1, pos[2]] })
      ]);
      const names = [feet?.result?.name, support?.result?.name, head?.result?.name];
      if (FLUIDS.has(names[0]) || FLUIDS.has(names[1]) || FLUIDS.has(names[2])) return null;
      if (!names[1] || EMPTY.has(names[1])) return null;
      return pos;
    } catch { return null; }
  }

  async recover({ deathEvent = null, previousInventory = null, previousStatus = null } = {}) {
    const status = this.worldModel?.latest?.status || previousStatus || {};
    const nearby = this.worldModel?.latest?.entities || [];
    const hostileDistances = nearby.filter(entity => entity.type === "hostile" || entity.type === "monster").map(entity => Number(entity.dist ?? entity.distance)).filter(Number.isFinite);
    if (hostileDistances.some(distance => distance <= 8)) {
      this.events.emit("death-loot-recovery-skipped", { reason: "nearby_hostile", distance: Math.min(...hostileDistances) });
      return { attempted: false, reason: "nearby_hostile" };
    }
    let target = deathPosition(deathEvent, status);
    let itemEntities = [];
    try {
      const response = await this.api.getEntities({ radius: 32, types: ["item"] });
      itemEntities = response.result?.entities || [];
      if (!target && itemEntities.length) target = floorPos(itemEntities[0].pos);
    } catch (error) {
      this.logger.warn?.("[death-recovery] 无法查询掉落物：" + error.message);
    }
    if (target) target = await this.#safeTarget(target);
    if (!target && itemEntities.length) {
      for (const entity of itemEntities.slice(0, 16)) {
        const safe = await this.#safeTarget(entity.pos);
        if (safe) { target = safe; break; }
      }
    }
    if (!target) {
      this.events.emit("death-loot-recovery-skipped", { reason: "no_drop_position" });
      return { attempted: false, reason: "no_drop_position" };
    }
    const currentPos = floorPos(status?.pos);
    if (currentPos && Math.hypot(target[0] - currentPos[0], target[2] - currentPos[2]) > 16) {
      this.events.emit("death-loot-recovery-skipped", { reason: "drop_too_far", target, current: currentPos });
      return { attempted: false, reason: "drop_too_far", target, current: currentPos };
    }

    this.events.emit("death-loot-recovery-start", { target, itemCount: itemEntities.length, cause: deathEvent?.cause || status.last_death?.cause || null });
    try {
      // Omit y: the server can report a death position one tick above/below
      // the actual ground. Horizontal arrival plus a fresh observation is
      // safer than forcing a cross-layer path into a water hole.
      await this.executor.enqueue({ type: "move_to", params: { x: target[0], z: target[2], range: 1 } }, { source: "recovery:death-loot", priority: 80, attempts: 1 });
    } catch (error) {
      this.events.emit("death-loot-recovery-error", { stage: "move_to_drop", target, error: { message: error.message, code: error.code } });
      return { attempted: true, recovered: false, target, error };
    }

    let inventory = null;
    try { inventory = (await this.api.inventory()).result; } catch (error) { this.logger.warn?.("[death-recovery] 无法刷新背包：" + error.message); }
    const equipped = [];
    for (const targetItem of loadout(previousInventory || {})) {
      if (!inventory || countItem(inventory, targetItem.item) <= 0) continue;
      try {
        await this.executor.enqueue({ type: "equip", params: targetItem }, { source: "recovery:death-loot", priority: 80, attempts: 1 });
        equipped.push(targetItem);
      } catch (error) {
        this.events.emit("death-loot-recovery-equip-error", { target: targetItem, error: { message: error.message, code: error.code } });
      }
    }
    let remaining = [];
    try { remaining = (await this.api.getEntities({ radius: 6, types: ["item"] })).result?.entities || []; } catch {}
    const recovered = itemEntities.length === 0 || remaining.length < itemEntities.length || equipped.length > 0;
    const result = { attempted: true, recovered, target, itemCount: itemEntities.length, remainingItems: remaining.length, inventory, equipped };
    this.events.emit("death-loot-recovery-complete", result);
    return result;
  }
}

export { deathPosition, loadout };
