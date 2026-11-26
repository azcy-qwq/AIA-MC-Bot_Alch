import { passableCell, solidSupport, protectedBlock } from "../core/spatial-observer.js";
import { isDirectCombatThreat } from "../tac/combat-target.js";
import { skillError } from "./helpers.js";
import { DISTRIBUTION_LEAD_MS, estimateWorkRemainingMs } from "../strategy/distribution-timing.js";

const WOOD = ["oak_log", "birch_log", "spruce_log", "jungle_log", "acacia_log", "dark_oak_log", "mangrove_log", "cherry_log", "pale_oak_log"];
const ORES = ["iron_ore", "deepslate_iron_ore"];
const AXES = ["netherite", "diamond", "iron", "stone", "wooden"].map(tier => `${tier}_axe`);
const PICKS = ["netherite", "diamond", "iron", "stone", "wooden"].map(tier => `${tier}_pickaxe`);
const DIRS = { x: [1, 0], "-x": [-1, 0], z: [0, 1], "-z": [0, -1] };
const distance = (a, b) => Math.hypot(...a.map((n, i) => n - b[i]));
const key = p => p.join(",");
const clean = n => String(n || "").replace(/^minecraft:/, "");
const bounded = (n, fallback, min, max) => Math.min(max, Math.max(min, Math.floor(Number(n) || fallback)));
const dropFor = type => /iron_ore$/.test(type) ? "raw_iron" : /gold_ore$/.test(type) ? "raw_gold" : /copper_ore$/.test(type) ? "raw_copper" : /coal_ore$/.test(type) ? "coal" : /diamond_ore$/.test(type) ? "diamond" : type;

/** One queued job owns the actuator. Substeps run through the executor's
 * checked operations without enqueueing behind their own parent job. */
export class AutonomousWorkScript {
  constructor({ api, worldModel }) { this.api = api; this.worldModel = worldModel; }

  async run(input = {}, { runAction, signal, onProgress = () => {} } = {}) {
    const mode = input.mode || "chop_tree";
    if (!["chop_tree", "mine_vein", "fishbone"].includes(mode)) throw skillError("未知采集模式", "bad_args");
    if (input.types !== undefined && !Array.isArray(input.types)) throw skillError("types 必须是方块名称数组", "bad_args");
    const types = (input.types || (mode === "chop_tree" ? WOOD : ORES)).map(clean);
    if (!types.length || types.some(t => mode === "chop_tree" ? !WOOD.includes(t) : !/(?:_ore|ancient_debris)$/.test(t))) throw skillError("采集脚本只接受原木或指定矿物，不允许无目标扩挖", "bad_args");
    const targetCount = bounded(input.targetCount, mode === "chop_tree" ? 32 : 16, 1, 256);
    const maxBlocks = bounded(input.maxBlocks, mode === "fishbone" ? 256 : 96, 1, 512);
    const maxTravel = bounded(input.maxTravel, 40, 4, 64);
    const radius = bounded(input.radius, 24, 4, 48);
    const startedAt = Date.now(), deadline = startedAt + bounded(input.maxDurationMs, 240000, 5000, 600000);
    const initialStatus = (await this.api.status()).result;
    const home = initialStatus?.pos;
    if (!Array.isArray(home)) throw skillError("缺少实际起点", "not_ready");
    const dimension = initialStatus.dimension;
    if (this.dimension !== dimension) this.skipped = new Map();
    this.dimension = dimension;
    const resources = new Set(input.items || types.map(dropFor));
    const state = { mode, targetCount, currentCount: 0, mined: 0, steps: 0, phase: "starting", nearEnd: false, startedAt };
    this.skipped ||= new Map();
    for (const [pos, until] of this.skipped) if (until < Date.now()) this.skipped.delete(pos);
    const skipped = this.skipped, explored = new Set([key(home.map(Math.floor))]);
    let inventory, status = initialStatus, noGain = 0, initialCount = null;
    const check = () => {
      if (signal?.aborted) throw skillError("采集脚本已被停止或 Tac 抢占", "cancelled");
      if (Date.now() >= deadline) throw skillError("采集脚本达到时间预算", "work_budget", { ...state });
    };
    const report = phase => {
      state.phase = phase;
      const now = Date.now(), elapsedMs = now - startedAt;
      const remaining = Math.max(0, targetCount - state.currentCount);
      state.estimatedRemainingMs = estimateWorkRemainingMs({ elapsedMs, remaining, gained: initialCount === null ? 0 : Math.max(0, state.currentCount - initialCount), mined: state.mined, maxBlocks, deadlineRemainingMs: deadline - now });
      state.estimatedAt = now;
      state.nearEnd = state.estimatedRemainingMs <= DISTRIBUTION_LEAD_MS;
      onProgress({ ...state, remaining, elapsedMs });
    };
    const run = async action => { check(); report(action.type); const result = await runAction(action); check(); return result; };
    const refresh = async () => {
      check();
      [status, inventory] = await Promise.all([this.api.status().then(r => r.result), this.api.inventory().then(r => r.result)]);
      check();
      if (!status?.alive || !status.ready) throw skillError("角色不可操作，停止脚本", "cancelled");
      if (status.dimension !== dimension) throw skillError("维度变化，停止沿用原作业范围", "work_unsafe");
      if (status.in_lava || status.on_fire || (status.submerged && status.oxygen < 100)) throw skillError("作业环境危险，交给 Tac", "work_unsafe");
      if (status.health < 6 || status.food < 4 || inventory?.empty_slots === 0) throw skillError("生命、饥饿或背包条件不满足，停止采集", "work_unsafe");
      if ((this.worldModel?.latest?.entities || []).some(e => ["hostile", "monster"].includes(e.type) && isDirectCombatThreat(status, e))) throw skillError("近身敌对，停止作业交给 Tac", "work_unsafe");
      if (distance(status.pos, home) > maxTravel + 1) throw skillError("到达作业活动范围边界", "work_budget", { ...state });
      state.currentCount = (inventory?.items || []).filter(i => resources.has(clean(i.name))).reduce((sum, i) => sum + Number(i.count || 0), 0);
      initialCount ??= state.currentCount;
      report("observing");
    };
    const block = async pos => { check(); return (await this.api.getBlock({ pos })).result; };
    const standable = async pos => {
      const cells = await Promise.all([-1, 0, 1, 2].map(dy => block([pos[0], pos[1] + dy, pos[2]])));
      return solidSupport(cells[0]) && cells.slice(1).every(passableCell);
    };
    const move = async pos => {
      if (distance(pos, home) > maxTravel || !await standable(pos)) return false;
      await run({ type: "move_to", params: { pos: [pos[0] + 0.5, pos[1], pos[2] + 0.5], exact: true } });
      state.steps++;
      status = (await this.api.status()).result;
      return true;
    };
    const approach = async pos => {
      // Never path to the ore/log voxel itself: find a supported clear cell.
      if (distance(status.pos, pos.map(v => v + 0.5)) <= 3.5) return true;
      const candidates = [];
      for (const [dx, dz] of Object.values(DIRS)) for (const dy of [0, -1, 1]) candidates.push([pos[0] + dx, pos[1] + dy, pos[2] + dz]);
      candidates.sort((a, b) => distance(a, status.pos) - distance(b, status.pos));
      for (const candidate of candidates) if (await standable(candidate)) return move(candidate);
      return false;
    };
    const equip = async name => {
      if (status.held?.name !== name) { await run({ type: "equip", params: { item: name, slot: "hand" } }); status.held = { name }; }
    };
    const selectTool = async type => {
      const names = new Set((inventory?.items || []).map(i => clean(i.name)));
      const tools = mode === "chop_tree" ? AXES : PICKS;
      const tool = tools.find(n => names.has(n));
      if (mode !== "chop_tree" && (!tool || (/(?:iron|copper|lapis)_ore$/.test(type) && tool === "wooden_pickaxe") || (/(?:diamond|gold|redstone|emerald)_ore$/.test(type) && ["wooden_pickaxe", "stone_pickaxe"].includes(tool)) || (type === "ancient_debris" && !["diamond_pickaxe", "netherite_pickaxe"].includes(tool)))) throw skillError("缺少能获得目标矿物掉落的镐", "missing_item", { type });
      if (tool) await equip(tool);
    };
    const gatherOne = async () => {
      const found = (await this.api.findBlocks({ types, radius, limit: 32 })).result?.blocks || [];
      const candidates = found.filter(b => Array.isArray(b.pos) && types.includes(b.name) && b.diggable !== false && (skipped.get(key(b.pos)) || 0) < Date.now())
        .filter(b => distance(b.pos, home) <= maxTravel && (mode === "chop_tree" || distance(b.pos, status.pos) <= (/diamond/.test(b.name) ? 24 : 8)))
        .sort((a, b) => distance(a.pos, status.pos) - distance(b.pos, status.pos));
      for (const candidate of candidates.slice(0, 4)) {
        check();
        try {
          await selectTool(candidate.name);
          if (!await approach(candidate.pos)) { skipped.set(key(candidate.pos), Date.now() + 45000); continue; }
          const actual = await block(candidate.pos);
          if (!types.includes(actual?.name)) continue;
          const before = state.currentCount;
          await run({ type: "dig", params: { pos: candidate.pos, single: true, purpose: "mine", collect: true } });
          state.mined++;
          await refresh();
          // A removed block with no inventory gain is not resource progress.
          noGain = state.currentCount > before ? 0 : noGain + 1;
          if (noGain >= 4) throw skillError("连续挖掘没有实际掉落入包，停止并重新评估", "work_no_progress", { ...state });
          return true;
        } catch (error) {
          if (["cancelled", "dead", "work_budget", "work_no_progress", "work_unsafe", "missing_item"].includes(error.code)) throw error;
          skipped.set(key(candidate.pos), Date.now() + 45000);
          report(`skip:${error.code || "unreachable"}`);
        }
      }
      return false;
    };
    const explore = async () => {
      const feet = status.pos.map(Math.floor), candidates = [];
      for (const [dx, dz] of Object.values(DIRS)) for (const dy of [0, 1, -1]) {
        const pos = [feet[0] + dx * 2, feet[1] + dy, feet[2] + dz * 2];
        if (!explored.has(key(pos)) && distance(pos, home) <= maxTravel) candidates.push(pos);
      }
      for (const pos of candidates) {
        explored.add(key(pos));
        if (await standable(pos)) {
          try { if (await move(pos)) return true; } catch (error) { if (["cancelled", "work_budget"].includes(error.code)) throw error; }
        }
      }
      return false;
    };
    await refresh();
    if (mode !== "fishbone") {
      let emptySearches = 0;
      while (state.currentCount < targetCount && state.mined < maxBlocks) {
        check();
        if (await gatherOne()) { emptySearches = 0; continue; }
        if (++emptySearches > 12 || !await explore()) break;
        await refresh();
      }
    } else {
      const forward = DIRS[input.direction || "z"];
      if (!forward) throw skillError("鱼骨方向应为 x/-x/z/-z", "bad_args");
      const length = bounded(input.length, 24, 1, 64), branchLength = bounded(input.branchLength, 5, 1, 12), branchEvery = bounded(input.branchEvery, 3, 2, 6);
      const initial = status.pos.map(Math.floor);
      const diggableTunnel = b => b?.name && !protectedBlock(b) && b.diggable !== false && /^(?:stone|deepslate|cobbled_deepslate|cobblestone|andesite|diorite|granite|tuff|dirt|grass_block|.*_ore)$/.test(b.name);
      const tunnelStep = async pos => {
        await refresh();
        if (state.currentCount >= targetCount || state.mined >= maxBlocks) return false;
        const feet = status.pos.map(Math.floor);
        if (distance(feet, pos) > 1.1) throw skillError("矿道施工必须紧随实际脚部位置", "unsafe_excavation");
        const positions = [1, 0].map(dy => [pos[0], pos[1] + dy, pos[2]]);
        const cells = await Promise.all(positions.map(block));
        if (cells.some(b => !passableCell(b) && !diggableTunnel(b))) throw skillError("矿道遇到未知、液体、沙砾或重要设施", "work_unsafe");
        // Inspect bordering cells before opening the tunnel; unknown data does
        // not grant permission to excavate into it.
        for (const p of positions) {
          const edges = await Promise.all(Object.values(DIRS).map(([dx, dz]) => block([p[0] + dx, p[1], p[2] + dz])));
          if (edges.some(b => !b?.name || /(?:water|lava|gravel|sand|portal)/.test(b.name))) throw skillError("矿道边界未确认或有液体/塌落风险", "work_unsafe");
        }
        await selectTool(types[0]);
        for (let i = 0; i < cells.length; i++) if (!passableCell(cells[i])) {
          if (state.mined >= maxBlocks) return false;
          await run({ type: "dig", params: { pos: positions[i], single: true, purpose: "mine" } }); state.mined++;
        }
        await move(pos);
        await refresh();
        while (state.currentCount < targetCount && state.mined < maxBlocks && await gatherOne()) { check(); }
        // Ore collection may have moved away; return before extending geometry.
        if (distance(status.pos.map(Math.floor), pos) > 0) await move(pos);
        return true;
      };
      main: for (let step = 1; step <= length; step++) {
        const center = [initial[0] + forward[0] * step, initial[1], initial[2] + forward[1] * step];
        if (!await tunnelStep(center)) break;
        if (step % branchEvery === 0) for (const sign of [-1, 1]) {
          const side = [-forward[1] * sign, forward[0] * sign];
          for (let branch = 1; branch <= branchLength; branch++) if (!await tunnelStep([center[0] + side[0] * branch, center[1], center[2] + side[1] * branch])) break main;
          await move(center);
        }
      }
    }
    await refresh();
    report("finished");
    if (state.currentCount < targetCount) throw skillError("本地采集达到边界，需 Distribution 调整目标/路线；不要重放同一脚本", "work_incomplete", { ...state });
    return { ...state, complete: true };
  }
}
