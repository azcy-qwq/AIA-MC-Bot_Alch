import { passableCell, protectedBlock, solidSupport } from "../core/spatial-observer.js";
import { skillError } from "./helpers.js";

const FOOD = ["golden_apple", "golden_carrot", "cooked_beef", "cooked_porkchop", "cooked_mutton", "cooked_chicken", "bread", "baked_potato"];
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const dist = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));

export class TacticalSurvivalScript {
  constructor({ api, executor, worldModel }) { this.api = api; this.executor = executor; this.worldModel = worldModel; }
  async state() {
    const [s, i] = await Promise.all([this.api.status(), this.api.inventory()]);
    if (!s.result?.alive || !s.result?.ready) throw skillError("Tac 角色不可操作", "cancelled");
    return { status: s.result, inventory: i.result };
  }
  run(action) { return this.executor.enqueue(action, { source: "tac:survival", priority: 100, attempts: 1 }); }
  async block(pos) { return (await this.api.getBlock({ pos })).result; }
  async standing(pos) {
    const cells = await Promise.all([-1, 0, 1].map(dy => this.block([pos[0], pos[1] + dy, pos[2]])));
    return solidSupport(cells[0]) && cells.slice(1).every(passableCell);
  }
  async shield() {
    const { status, inventory } = await this.state();
    if (status.offhand?.name !== "shield" && inventory?.offhand?.name !== "shield") {
      if (!inventory?.items?.some(i => i.name === "shield")) return false;
      await this.run({ type: "equip", params: { item: "shield", slot: "off-hand" } });
    }
    await this.run({ type: "posture", params: { shield: true } });
    return true;
  }
  async eat() {
    const { status, inventory } = await this.state();
    if (status.food >= 20) return false;
    const item = FOOD.find(name => inventory?.items?.some(i => i.name === name));
    if (!item) return false;
    await this.run({ type: "posture", params: { shield: false } });
    await this.run({ type: "use_item", params: { item, timeout: 6000 } });
    return true;
  }
  async flee(hostile = null) {
    if (!this.api.getBlock) return false;
    const { status } = await this.state(), origin = status.pos.map(Math.floor);
    const candidates = [];
    for (const [dx, dz] of DIRS) for (const dy of [0, 1, -1]) candidates.push([origin[0] + dx * 2, origin[1] + dy, origin[2] + dz * 2]);
    candidates.sort((a, b) => (hostile?.pos ? dist(b, hostile.pos) - dist(a, hostile.pos) : Math.abs(a[1] - origin[1]) - Math.abs(b[1] - origin[1])));
    for (const pos of candidates) {
      if (hostile?.pos && dist(pos, hostile.pos) <= dist(status.pos, hostile.pos)) continue;
      if (!await this.standing(pos)) continue;
      try { await this.run({ type: "move_to", params: { pos: [pos[0] + 0.5, pos[1], pos[2] + 0.5], exact: true } }); return true; }
      catch (error) { if (["dead", "cancelled"].includes(error.code)) throw error; }
    }
    return false;
  }
  async barricade(hostile) {
    if (!hostile?.pos || !this.api.getBlock) return false;
    const { status, inventory } = await this.state();
    const item = ["cobblestone", "dirt", "cobbled_deepslate"].find(name => inventory?.items?.some(i => i.name === name && i.count > 0));
    if (!item || dist(status.pos, hostile.pos) < 2) return false;
    const dx = hostile.pos[0] - status.pos[0], dz = hostile.pos[2] - status.pos[2];
    const step = Math.abs(dx) > Math.abs(dz) ? [Math.sign(dx), 0] : [0, Math.sign(dz)];
    const feet = status.pos.map(Math.floor), pos = [feet[0] + step[0], feet[1], feet[2] + step[1]];
    // One obstacle facing the threat; preserve a verified exit on another side.
    let exit = false;
    for (const [ex, ez] of DIRS) if ((ex !== step[0] || ez !== step[1]) && await this.standing([feet[0] + ex, feet[1], feet[2] + ez])) { exit = true; break; }
    if (!exit || !await this.standing(pos) || !passableCell(await this.block([feet[0], feet[1] + 1, feet[2]]))) return false;
    await this.run({ type: "place", params: { item, pos } });
    return true;
  }
  async shelter() {
    if (!this.api.getBlock) return false;
    const { status, inventory } = await this.state(), origin = status.pos.map(Math.floor);
    const item = ["cobblestone", "dirt", "cobbled_deepslate"].find(name => inventory?.items?.some(i => i.name === name));
    if (!item || (!FOOD.some(n => inventory?.items?.some(i => i.name === n)) && status.food < 18)) return false;
    for (const [dx, dz] of DIRS) {
      // Safe horizontal equivalent of 挖三填一: three-cell retreat with
      // solid roof/floor, two-high clearance, one removable entrance block.
      // Never dig a vertical shaft under the player or seal the player in.
      const columns = [1, 2, 3].map(n => [origin[0] + dx * n, origin[1], origin[2] + dz * n]);
      const dig = [];
      let safe = true;
      for (const pos of columns) {
        const cells = await Promise.all([-1, 0, 1, 2].map(dy => this.block([pos[0], pos[1] + dy, pos[2]])));
        if (!solidSupport(cells[0]) || !solidSupport(cells[3])) { safe = false; break; }
        for (const [index, cell] of cells.slice(1, 3).entries()) {
          if (!passableCell(cell) && (!cell?.name || cell.diggable === false || protectedBlock(cell) || !/^(?:stone|dirt|grass_block|deepslate|tuff|andesite|diorite|granite|cobblestone)$/.test(cell.name))) { safe = false; break; }
          if (!passableCell(cell)) dig.push([pos[0], pos[1] + index, pos[2]]);
          const sides = await Promise.all(DIRS.map(([sx, sz]) => this.block([pos[0] + sx, pos[1] + index, pos[2] + sz])));
          if (sides.some(b => !b?.name || /(?:water|lava|sand|gravel)/.test(b.name))) safe = false;
        }
      }
      if (!safe) continue;
      const cap = columns[0];
      let sealed = false;
      try {
        for (const pos of columns) {
          for (const target of dig.filter(p => p[0] === pos[0] && p[2] === pos[2]).sort((a, b) => b[1] - a[1])) await this.run({ type: "dig", params: { pos: target, single: true, purpose: "shelter" } });
          await this.run({ type: "move_to", params: { pos: [pos[0] + 0.5, pos[1], pos[2] + 0.5], exact: true } });
        }
        await this.run({ type: "place", params: { pos: cap, item } }); sealed = true;
        await this.eat();
        const until = Date.now() + 10000;
        while (Date.now() < until) {
          const { status: s } = await this.state();
          if (s.health >= 18 || s.food < 18 || s.on_fire || s.in_lava || s.oxygen < 100) break;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        return true;
      } finally {
        if (sealed && !this.executor.paused) await this.run({ type: "dig", params: { pos: cap, single: true, purpose: "shelter" } }).catch(() => {});
      }
    }
    return false;
  }
  async respond({ responses = [], hostile = null } = {}) {
    for (const response of [...new Set(responses)].slice(0, 3)) {
      await this.state();
      if (response === "shield") await this.shield();
      if (response === "flee") {
        const fled = await this.flee(hostile);
        if (!fled && hostile) {
          await this.barricade(hostile);
          if ((await this.state()).status.health < 10) await this.shelter();
        }
      }
      if (response === "barricade") await this.barricade(hostile);
      if (response === "shelter") await this.shelter();
      if (response === "eat") await this.eat();
    }
  }
}
