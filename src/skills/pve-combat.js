import { chooseFirstItem, itemNames, skillError, sleep } from "./helpers.js";
import { isDirectCombatThreat } from "../tac/combat-target.js";
import { passableCell, solidSupport } from "../core/spatial-observer.js";

const MELEE_WEAPONS = ["netherite_sword", "diamond_sword", "iron_sword", "stone_sword", "golden_sword", "wooden_sword", "netherite_axe", "diamond_axe", "iron_axe", "stone_axe", "wooden_axe"];
const FOOD = ["golden_carrot", "cooked_beef", "cooked_porkchop", "cooked_chicken", "bread", "baked_potato"];

/**
 * Deterministic PVE helper. The API's /attack already follows a target, while
 * this wrapper handles target selection, equipment, shield posture and recovery.
 */
export class PveCombatScript {
  constructor({ api, worldModel, executor, logger = console }) {
    this.api = api;
    this.worldModel = worldModel;
    this.executor = executor;
    this.logger = logger;
    this.skippedUntil = new Map();
    this.lastSwingAt = 0;
    this.jumpUnsupported = false;
  }

  async jumpAttack({ entity_id }, { runAction, signal }) {
    const check = () => { if (signal?.aborted) throw skillError("跳砍已取消", "cancelled"); };
    check();
    if (this.jumpUnsupported || !this.api.control || !this.api.look || !this.api.getBlock || !this.api.getEntities) return { attempted: false };
    const s = (await this.api.status()).result;
    const eligible = s?.ready && s.alive && s.on_ground === true && s.health >= 10 && !s.in_water && !s.in_lava && !s.in_vehicle && !s.sneaking;
    if (!eligible || !s.pos) return { attempted: false };
    const target = (await this.api.getEntities({ radius: 4, types: ["hostile"] })).result?.entities?.find(e => e.id === entity_id);
    if (!target?.pos || target.name?.replace(/^minecraft:/, "") === "creeper" || !isDirectCombatThreat(s, target) || Math.hypot(...s.pos.map((v, i) => v - target.pos[i])) > 2.6) return { attempted: false };
    const feet = s.pos.map(Math.floor);
    const cells = await Promise.all([-1, 2, 3].map(dy => this.api.getBlock({ pos: [feet[0], feet[1] + dy, feet[2]] }).then(r => r.result)));
    if (!solidSupport(cells[0]) || !cells.slice(1).every(passableCell)) return { attempted: false };
    const cooldown = /axe$/.test(s.held?.name || "") ? 1300 : /sword$/.test(s.held?.name || "") ? 650 : 1000;
    if (Date.now() - this.lastSwingAt < cooldown) return { attempted: false };
    try {
      await runAction({ type: "control", params: { jump: true, ms: 100 } });
      const deadline = Date.now() + 500;
      while (Date.now() < deadline) {
        check();
        const now = (await this.api.status()).result;
        if (!now?.alive || !now.ready || now.health < 10 || now.in_water || now.in_lava || now.in_vehicle) return { attempted: true, hit: false };
        if (now.on_ground === false && Number.isFinite(now.velocity?.[1]) && now.velocity[1] < -0.1) {
          await runAction({ type: "look", params: { entity_id } });
          const result = await runAction({ type: "control", params: { hit: true, ms: 50 } });
          this.lastSwingAt = Date.now();
          this.executor.events?.emit("combat-jump-attack", { targetId: entity_id, fallingObserved: true, hits: result?.result?.hits || [] });
          return { attempted: true, hit: true, result };
        }
        if (now.on_ground === true) return { attempted: true, hit: false };
        await sleep(25);
      }
      return { attempted: true, hit: false };
    } catch (error) {
      if (["unknown_api", "not_found"].includes(error.code) || error.status === 404) { this.jumpUnsupported = true; return { attempted: false }; }
      throw error;
    }
  }

  async firstStrike({ target = null, timeoutMs = 1000 } = {}) {
    const snapshot = this.worldModel.latest;
    target ||= (snapshot.entities || []).find(e => ["hostile", "monster"].includes(e.type) && isDirectCombatThreat(snapshot.status, e));
    // Every emergency starts here, including lava/falling. With no actual
    // close target this script returns immediately instead of chasing a mob.
    if (!target?.id || !isDirectCombatThreat(snapshot.status, target) || (this.skippedUntil.get(target.id) || 0) > Date.now()) return { skipped: true, reason: "no_direct_target" };
    try {
      if (snapshot.status?.blocking) await this.executor.enqueue({ type: "posture", params: { shield: false } }, { source: "tac:first-strike", priority: 100, attempts: 1 });
      if (this.executor.skillActions?.has("jump_attack")) {
        const jump = await this.executor.enqueue({ type: "jump_attack", params: { entity_id: target.id } }, { source: "tac:first-strike", priority: 100, attempts: 1 });
        if (jump.hit) return { target, result: jump.result, killed: false, jumpAttack: true };
      }
      const result = await this.executor.enqueue({ type: "attack", params: { entity_id: target.id, timeout: Math.min(target.name === "creeper" ? 350 : 1200, timeoutMs) } }, { source: "tac:first-strike", priority: 100, attempts: 1 });
      this.lastSwingAt = Date.now();
      return { target, result, killed: Boolean(result?.result?.killed) };
    } catch (error) {
      if (["no_such_entity", "entity_not_visible", "target_not_visible", "no_line_of_sight", "out_of_range"].includes(error.code)) {
        this.skippedUntil.set(target.id, Date.now() + 12000);
        return { skipped: true, reason: error.code, target };
      }
      if (["timeout", "interrupted", "busy", "action_timeout"].includes(error.code)) return { interrupted: true, target };
      throw error;
    }
  }

  async findTarget({ names, radius = 16 } = {}) {
    const result = await this.api.getEntities({ radius, types: names?.length ? names : ["hostile"] });
    return result.result?.entities?.find(entity => entity.type === "hostile" || !names?.length) || null;
  }

  async engage({ entityId, names, radius = 16, timeoutMs = 20000, shield = true, eatBelowHealth = 10 } = {}) {
    const target = entityId ? { id: entityId } : await this.findTarget({ names, radius });
    if (!target?.id) throw skillError("No hostile target found", "no_target");

    const snapshot = this.worldModel.latest;
    const namesInInventory = itemNames(snapshot.inventory);
    const weapon = chooseFirstItem(snapshot.inventory, MELEE_WEAPONS);
    if (weapon) await this.executor.enqueue({ type: "equip", params: { item: weapon, slot: "hand" } }, { source: "skill:pve-equip", priority: 40 });

    if (shield && namesInInventory.has("shield")) {
      await this.executor.enqueue({ type: "posture", params: { shield: true } }, { source: "skill:pve-shield", priority: 40 });
    }

    const deadline = Date.now() + timeoutMs;
    let lastResult;
    while (Date.now() < deadline) {
      const status = (await this.api.status()).result;
      if (!status?.alive) throw skillError("Bot died during combat", "dead");
      if (status.health <= eatBelowHealth) {
        const food = chooseFirstItem(this.worldModel.latest.inventory, FOOD);
        if (food) {
          await this.executor.enqueue({ type: "use_item", params: { item: food, timeout: 10000 } }, { source: "skill:pve-eat", priority: 80 });
        } else if (shield) {
          await this.executor.enqueue({ type: "posture", params: { shield: true } }, { source: "skill:pve-retreat", priority: 80 });
        }
      }

      try {
        lastResult = await this.executor.enqueue({ type: "attack", params: { entity_id: target.id, timeout: Math.min(8000, deadline - Date.now()) } }, { source: "skill:pve-attack", priority: 50, attempts: 1 });
        if (lastResult?.result?.killed || lastResult?.killed) return { target, result: lastResult, killed: true };
      } catch (error) {
        if (!["interrupted", "no_such_entity", "timeout", "dead"].includes(error.code)) throw error;
        if (error.code === "no_such_entity") return { target, result: lastResult, skipped: true, killed: false };
        this.logger.warn?.("PVE attack interrupted; reassessing", error.code);
      }
      await sleep(100);
    }
    throw skillError("PVE combat timed out", "timeout", { target, lastResult });
  }

  async disengage() {
    await this.executor.stop();
    await this.executor.enqueue({ type: "posture", params: {} }, { source: "skill:pve-disengage", priority: 90 });
  }
}
