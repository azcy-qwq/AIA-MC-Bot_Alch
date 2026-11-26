// Only public get_block observations are used. Failed/hidden observations
// remain unknown; a missing result is never treated as air or solid ground.
export const AIR = new Set(["air", "cave_air"]);
const PASSABLE = new Set([...AIR, "grass", "short_grass", "tall_grass", "fern", "large_fern", "torch", "wall_torch", "dandelion", "poppy", "wildflowers", "leaf_litter", "pink_petals", "sugar_cane", "wheat", "carrots", "potatoes", "beetroots", "nether_wart"]);
const HAZARDS = new Set(["lava", "flowing_lava", "water", "flowing_water", "bubble_column", "fire", "soul_fire", "cactus", "magma_block", "powder_snow", "void_air"]);
const PROTECTED = /(?:chest|barrel|furnace|crafting_table|spawner|portal|bedrock|barrier|bed$|anvil|enchanting_table)/;
export const solidSupport = block => Boolean(block?.name && !PASSABLE.has(block.name) && !HAZARDS.has(block.name) && !/(?:leaves|ladder|vine|rail|flower|sapling|carpet|fence|wall$|door|slab|stairs|sign|button|pressure_plate)/.test(block.name));
export const passableCell = block => Boolean(block?.name && PASSABLE.has(block.name));
export const protectedBlock = block => PROTECTED.test(block?.name || "");
const floor = pos => pos.map(Math.floor);
const key = pos => pos.join(",");
const DIRECTIONS = [{ name: "北(-Z)", direction: "-z", dx: 0, dz: -1 }, { name: "东(+X)", direction: "x", dx: 1, dz: 0 }, { name: "南(+Z)", direction: "z", dx: 0, dz: 1 }, { name: "西(-X)", direction: "-x", dx: -1, dz: 0 }];

export function describeSpace({ origin, cells, dimension, observedAt = Date.now() }) {
  const map = new Map(cells.map(cell => [key(cell.pos), cell]));
  const at = (dx, dy, dz) => map.get(key([origin[0] + dx, origin[1] + dy, origin[2] + dz]));
  const classify = cell => !cell?.name ? "unknown" : HAZARDS.has(cell.name) ? "hazard" : passableCell(cell) ? "clear" : protectedBlock(cell) ? "protected" : "blocked";
  const columns = DIRECTIONS.map(dir => {
    const support = at(dir.dx, -1, dir.dz), feet = at(dir.dx, 0, dir.dz), head = at(dir.dx, 1, dir.dz), overhead = at(dir.dx, 2, dir.dz);
    const upSupport = feet;
    const upClearance = [head, overhead, at(dir.dx, 3, dir.dz)];
    const known = [support, feet, head, overhead].every(c => c?.name);
    const digCells = [...upClearance, at(0, 2, 0)].filter(c => c?.name && !passableCell(c));
    const canExcavateUp = solidSupport(upSupport) && [...upClearance, at(0, 2, 0)].every(c => c?.name && !HAZARDS.has(c.name) && !protectedBlock(c) && (passableCell(c) || c.diggable !== false));
    return { ...dir, support: support?.name || "unknown", feet: feet?.name || "unknown", head: head?.name || "unknown", overhead: overhead?.name || "unknown", known,
      walkable: solidSupport(support) && passableCell(feet) && passableCell(head),
      stepUpWalkable: solidSupport(upSupport) && upClearance.every(passableCell) && passableCell(at(0, 2, 0)),
      stairCandidate: canExcavateUp ? { support: upSupport.pos, standAt: [origin[0] + dir.dx + 0.5, origin[1] + 1, origin[2] + dir.dz + 0.5], dig: digCells.map(c => ({ pos: c.pos, name: c.name })) } : null };
  });
  const symbols = { unknown: "?", hazard: "!", clear: ".", protected: "P", blocked: "#" };
  const slices = [-1, 0, 1, 2, 3].map(dy => ({ y: origin[1] + dy, rows: [-2, -1, 0, 1, 2].map(dz => [-2, -1, 0, 1, 2].map(dx => dy === 0 && dx === 0 && dz === 0 ? "@" : symbols[classify(at(dx, dy, dz))]).join("")) }));
  const hazards = cells.filter(c => HAZARDS.has(c.name)).map(c => ({ pos: c.pos, name: c.name }));
  const notes = ["坐标代表玩家脚部；地面支撑在 Y-1，头部在 Y+1，跳跃/楼梯还需检查 Y+2。", "方块摘要里的 nearest 是方块坐标，不是可站立的目的地。", "? 为未观察，不等于空气；仅由公开接口验证过的支撑和净空可作为通路证据。"];
  if (!columns.some(c => c.walkable || c.stepUpWalkable)) notes.push("当前未确认平走出口；先检查相邻列和原位置头顶，按最少修改选择单级台阶，禁止随机扩挖周围石头。");
  return { dimension, origin, observedAt, knownCells: cells.filter(c => c.name).length, requestedCells: cells.length, ownColumn: [-1, 0, 1, 2, 3].map(dy => ({ y: origin[1] + dy, name: at(0, dy, 0)?.name || "unknown" })), columns, slices, hazards, notes,
    legend: "行从北到南，列从西到东；@玩家，#占用，.可穿过，!危险，P重要方块，?未知" };
}

export class SpatialObserver {
  constructor(api, { intervalMs = 15000, concurrency = 4 } = {}) { this.api = api; this.intervalMs = intervalMs; this.concurrency = concurrency; this.latest = null; this.running = null; this.generation = 0; }
  current(status) {
    if (!this.latest || !Array.isArray(status?.pos) || this.latest.dimension !== status.dimension || Date.now() - this.latest.observedAt > 30000) return null;
    return key(this.latest.origin) === key(floor(status.pos)) ? this.latest : null;
  }
  invalidate() { this.generation++; this.latest = null; }
  async observe(status, { force = false } = {}) {
    if (!this.api.getBlock || !Array.isArray(status?.pos) || !status.alive || !status.ready) return null;
    if (this.running) return this.running;
    if (!force && this.current(status) && Date.now() - this.latest.observedAt < this.intervalMs) return this.latest;
    const origin = floor(status.pos), generation = this.generation, dimension = status.dimension;
    const positions = [];
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      if (Math.abs(dx) + Math.abs(dz) > 2) continue;
      for (let dy = -1; dy <= 3; dy++) positions.push([origin[0] + dx, origin[1] + dy, origin[2] + dz]);
    }
    this.running = (async () => {
      const cells = new Array(positions.length); let index = 0;
      await Promise.all(Array.from({ length: this.concurrency }, async () => {
        while (index < positions.length) {
          const i = index++, pos = positions[i];
          try { const response = await this.api.getBlock({ pos }); cells[i] = { pos, name: response?.result?.name || null, diggable: response?.result?.diggable }; }
          catch { cells[i] = { pos, name: null }; }
        }
      }));
      const result = describeSpace({ origin, cells, dimension });
      if (generation === this.generation) this.latest = result;
      return result;
    })().finally(() => { this.running = null; });
    return this.running;
  }
}
