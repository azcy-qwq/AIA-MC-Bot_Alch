import { floorPos, itemNames, skillError, sleep } from "./helpers.js";
import { solidSupport, protectedBlock } from "../core/spatial-observer.js";

const FLUIDS = new Set(["lava", "water", "bubble_column", "flowing_lava", "flowing_water"]);
const EMPTY = new Set(["air", "cave_air"]);
const UNSAFE = new Set(["bedrock", "barrier", "lava", "flowing_lava", "water", "flowing_water"]);
const CARDINALS = { x: [1, 0, 0], "-x": [-1, 0, 0], z: [0, 0, 1], "-z": [0, 0, -1] };
const DIRECT_PATH_FAILURES = new Set(["path_not_found", "timeout", "unreachable", "no_path", "navigation_failed", "stalled"]);
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const countItem = (inventory, name) => (inventory?.items || []).filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);

export class NavigationSkill {
  constructor({ api, worldModel, logger = console }) {
    this.api = api;
    this.worldModel = worldModel;
    this.logger = logger;
  }

  async #block(pos) {
    const result = await this.api.getBlock({ pos });
    return result.result;
  }

  async #status() {
    return (await this.api.status()).result;
  }

  async #solid(pos) {
    const block = await this.#block(pos);
    return solidSupport(block);
  }

  async #assertSafe(pos) {
    const block = await this.#block(pos);
    if (!solidSupport(block)) {
      throw skillError(`导航路线不安全，目标方块为 ${block?.name || "未知"}`, "unsafe_navigation", { pos, block: block?.name });
    }
    return block;
  }

  async #stepSupport(pos, preferred) {
    const cell = await this.#block(pos);
    if (solidSupport(cell)) return false;
    if (!EMPTY.has(cell?.name)) throw skillError("台阶支撑未知或危险，停止施工", "unsafe_navigation", { pos, block: cell?.name });
    const inventory = this.api.inventory ? (await this.api.inventory()).result : null;
    const item = [preferred, "cobblestone", "cobbled_deepslate", "dirt"].find(name => name && countItem(inventory, name) > 0);
    if (!item) throw skillError("台阶脚下是空气，缺少补足落脚面的方块", "no_support", { pos });
    let attached = false;
    for (const offset of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      if (await this.#solid(add(pos, offset))) { attached = true; break; }
    }
    if (!attached) throw skillError("台阶脚下空气没有可附着面，停止施工", "no_support", { pos });
    await this.api.place({ item, pos });
    await this.#assertSafe(pos);
    return true;
  }

  async #tryDirect(target) {
    try {
      const response = await this.api.moveTo({ x: target[0], y: target[1], z: target[2], range: 1 });
      const actual = response?.result?.pos || response?.pos || (await this.#status())?.pos;
      if (Array.isArray(actual) && actual.length >= 3) {
        const distance = Math.hypot(Number(actual[0]) - target[0], Number(actual[1]) - target[1], Number(actual[2]) - target[2]);
        if (distance > 1.6 || Math.abs(Number(actual[1]) - target[1]) > 0.6) return false;
      }
      return true;
    } catch (error) {
      if (DIRECT_PATH_FAILURES.has(error?.code)) return false;
      throw error;
    }
  }

  async #moveStep(target) {
    const response = await this.api.moveTo({ x: target[0] + 0.5, y: target[1], z: target[2] + 0.5, range: 0.3 });
    // The endpoint can finish while the player is still in a jump. Verify
    // settled server observations instead of mistaking the apex for arrival.
    let observed = await this.#status(), stable = 0;
    for (let poll = 0; poll < 5; poll++) {
      const pos = observed?.pos;
      const arrived = Array.isArray(pos) && Math.floor(pos[0]) === target[0] && Math.floor(pos[2]) === target[2] && Math.abs(pos[1] - target[1]) <= 0.2 && observed.on_ground !== false;
      stable = arrived ? stable + 1 : 0;
      if (stable >= 2) return floorPos(pos);
      await sleep(100);
      observed = await this.#status();
    }
    const actual = observed?.pos || response?.result?.pos || response?.pos;
    if (!Array.isArray(actual) || Math.floor(actual[0]) !== target[0] || Math.floor(actual[2]) !== target[2] || Math.abs(actual[1] - target[1]) > 0.6) {
      throw skillError("移动返回后未站上预期台阶，停止扩挖并重新观察", "navigation_failed", { target, actual });
    }
    throw skillError("尚未在台阶上稳定站立，停止后续施工", "navigation_failed", { target, actual });
  }

  async recover({ target, x, y, z, mode = "auto", direction, maxSteps = 16, block = "cobblestone", ladder = "ladder", onProgress = () => {} } = {}) {
    const rawGoal = target || { x, y, z };
    const goal = Array.isArray(rawGoal) ? { x: rawGoal[0], y: rawGoal[1], z: rawGoal[2] } : rawGoal;
    if (!goal || !Number.isFinite(goal.x) || !Number.isFinite(goal.z)) throw skillError("需要提供寻路目标坐标", "bad_args");
    const status = await this.#status();
    const current = floorPos(status.pos);
    const goalY = Number.isFinite(goal.y) ? Math.floor(goal.y) : current[1];
    const steps = Math.min(24, Math.max(1, Number(maxSteps) || 16));
    const directTarget = [Math.floor(goal.x), goalY, Math.floor(goal.z)];

    if (mode === "staircase" || (mode === "auto" && goalY <= current[1] - 2)) {
      if (await this.#tryDirect(directTarget)) return { mode: "direct", reached: true, position: directTarget };
      const dir = direction || this.#direction(current, goal);
      return this.staircaseDown({ origin: current, direction: dir, steps, onProgress });
    }
    if (mode === "ladder" || (mode === "auto" && goalY >= current[1] + 3 && Math.abs(goal.x - current[0]) <= 1 && Math.abs(goal.z - current[2]) <= 1 && countItem(this.worldModel?.latest?.inventory, ladder) >= Math.min(steps, goalY - current[1]))) {
      return this.climbLadder({ origin: current, target: [Math.floor(goal.x), goalY, Math.floor(goal.z)], ladder, maxSteps: steps, onProgress });
    }
    if (mode === "up" || (mode === "auto" && goalY > current[1])) {
      if (await this.#tryDirect(directTarget)) return { mode: "direct", reached: true, position: directTarget };
      const dir = direction || this.#direction(current, goal);
      return this.staircaseUp({ origin: current, direction: dir, steps, onProgress });
    }
    if (mode === "bridge" || mode === "auto") {
      return this.bridgeTo({ origin: current, target: [Math.floor(goal.x), goalY, Math.floor(goal.z)], block, maxSteps: steps, onProgress });
    }
    throw skillError(`不支持的导航恢复模式：${mode}`, "bad_args");
  }

  #direction(from, to) {
    // Compare block columns, not a block corner to a fractional centre.
    // Otherwise a north-only goal can incorrectly select east on a tie.
    const dx = Math.floor(to.x) - Math.floor(from[0]);
    const dz = Math.floor(to.z) - Math.floor(from[2]);
    if (Math.abs(dx) >= Math.abs(dz)) return dx >= 0 ? "x" : "-x";
    return dz >= 0 ? "z" : "-z";
  }

  async bridgeTo({ origin, target, block = "cobblestone", maxSteps = 16, onProgress = () => {} } = {}) {
    const status = await this.#status();
    const start = origin || floorPos(status.pos);
    const goal = target || start;
    const inventory = (await this.api.inventory()).result;
    if (!itemNames(inventory).has(block)) throw skillError(`缺少搭桥方块：${block}`, "missing_item", { item: block });
    const y = Math.floor(start[1]);
    const dx = Math.sign(goal[0] - start[0]);
    const dz = Math.sign(goal[2] - start[2]);
    if (dx && dz) throw skillError("搭桥路线需沿 X 或 Z 轴直线指定", "bad_args");
    const distance = Math.abs(goal[0] - start[0]) + Math.abs(goal[2] - start[2]);
    const length = Math.min(distance, Math.min(24, Math.max(1, Number(maxSteps) || 16)));
    if (!length) return { mode: "bridge", placed: 0, moved: 0, reached: true };
    let previousSupport = [start[0], y - 1, start[2]];
    const firstSupport = await this.#block(previousSupport);
    if (!firstSupport || EMPTY.has(firstSupport.name) || UNSAFE.has(firstSupport.name)) throw skillError("当前位置缺少可搭桥的安全支撑", "no_support", { pos: previousSupport });
    const vector = [dx, 0, dz];
    await this.api.posture({ sneak: true });
    let placed = 0;
    let moved = 0;
    try {
      for (let index = 1; index <= length; index += 1) {
        const feet = add(start, [vector[0] * index, 0, vector[2] * index]);
        const support = [feet[0], y - 1, feet[2]];
        const existing = await this.#block(support);
        if (!existing || EMPTY.has(existing.name)) {
          if (!await this.#solid(previousSupport)) throw skillError("前方没有安全搭桥支撑，停止继续", "unsafe_navigation", { pos: previousSupport });
          await this.api.place({ item: block, pos: support });
          placed += 1;
        } else if (UNSAFE.has(existing.name)) {
          throw skillError(`桥面存在危险方块：${existing.name}`, "unsafe_navigation", { pos: support });
        }
        await this.api.moveTo({ x: feet[0], z: feet[2], range: 0.6 });
        moved += 1;
        previousSupport = support;
        onProgress({ mode: "bridge", completed: index, total: length, placed, pos: feet });
      }
    } finally {
      await this.api.posture({});
    }
    return { mode: "bridge", placed, moved, reached: moved === distance };
  }

  async climbLadder({ origin, target, ladder = "ladder", maxSteps = 16, onProgress = () => {} } = {}) {
    const status = await this.#status();
    const start = origin || floorPos(status.pos);
    const goal = target || start;
    if (Math.abs(goal[0] - start[0]) > 1 || Math.abs(goal[2] - start[2]) > 1) throw skillError("梯子路线只支持当前位置附近的垂直攀爬", "bad_args");
    if (goal[1] <= start[1]) throw skillError("梯子目标必须高于当前位置", "bad_args");
    const inventory = (await this.api.inventory()).result;
    const available = countItem(inventory, ladder);
    const height = Math.min(goal[1] - start[1], Math.min(24, Number(maxSteps) || 16));
    if (available < height) throw skillError(`梯子不足，需要 ${height} 个，当前 ${available} 个`, "missing_item", { item: ladder, need: height, available });
    let placed = 0;
    for (let offset = 1; offset <= height; offset += 1) {
      const pos = [start[0], start[1] + offset, start[2]];
      const cell = await this.#block(pos);
      if (cell && !EMPTY.has(cell.name) && cell.name !== ladder) throw skillError(`梯子路线被 ${cell.name} 阻挡`, "unsafe_navigation", { pos });
      let attached = false;
      for (const side of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
        if (await this.#solid(add(pos, side))) { attached = true; break; }
      }
      if (!attached) throw skillError("当前位置附近没有可供梯子附着的墙面", "no_support", { pos });
      if (!cell || cell.name !== ladder) {
        await this.api.place({ item: ladder, pos });
        placed += 1;
      }
      onProgress({ mode: "ladder", completed: offset, total: height, placed, pos });
    }
    await this.api.moveTo({ x: goal[0], y: start[1] + height, z: goal[2], range: 1 });
    return { mode: "ladder", placed, climbed: height };
  }

  async staircaseDown({ origin, target = null, direction, steps = 2, block = "cobblestone", preferDirect = false, onProgress = () => {} } = {}) {
    const current = await this.#status();
    if (target && !Array.isArray(target)) target = [target.x, target.y, target.z];
    direction ||= target ? this.#direction(floorPos(current.pos), { x: target[0], z: target[2] }) : "z";
    const vector = CARDINALS[direction];
    if (!vector) throw skillError("direction 必须为 x、-x、z 或 -z", "bad_args");
    const status = current;
    if (origin && Math.hypot(...origin.map((value, axis) => value - status.pos[axis])) > 1.5) throw skillError("楼梯起点必须是角色实际位置", "bad_args");
    let feet = origin ? floorPos(origin) : floorPos(status.pos);
    // Keep recovery segments short.  A long diagonal tunnel frequently puts
    // the next block outside the API's reach after the first step; callers
    // can invoke the skill again after the position has been verified.
    const count = Math.min(2, Number.isFinite(target?.[1]) && target[1] < feet[1] ? Math.max(1, feet[1] - Math.floor(target[1])) : 2, Math.max(1, Number(steps) || 2));
    const directGoal = Array.isArray(target) && target.length >= 3
      ? floorPos(target)
      : add(feet, [vector[0] * count, -count, vector[2] * count]);
    if (preferDirect) {
      if (await this.#tryDirect(directGoal)) return { mode: "direct", reached: true, position: directGoal };
      const actual = floorPos((await this.#status()).pos);
      if (actual.some((v, i) => v !== feet[i])) throw skillError("普通寻路产生部分位移，请从实际位置重新观察后施工", "navigation_failed", { actual, previous: feet });
    }
    let dug = 0, placed = 0;
    for (let step = 0; step < count; step += 1) {
      const nextFeet = add(feet, [vector[0], -1, vector[2]]);
      const head = add(nextFeet, [0, 1, 0]);
      const knee = add(nextFeet, [0, 2, 0]);
      const support = add(nextFeet, [0, -1, 0]);
      // Keep three vertical cells clear at the next position. The middle
      // cell is the agent's head space and the upper cell is the extra
      // overhead margin requested for safe movement.
      const toDig = [knee, head, nextFeet];
      const blocks = [];
      for (const pos of toDig) {
        const found = await this.#block(pos);
        if (!found?.name) throw skillError("下行空间尚未确认，停止挖掘", "unknown_block", { pos });
        if (protectedBlock(found)) throw skillError("楼梯会破坏重要设施，停止施工", "unsafe_navigation", { pos, block: found.name });
        if (found && FLUIDS.has(found.name)) throw skillError(`台阶内发现 ${found.name}，停止挖掘`, "unsafe_navigation", { pos, block: found.name });
        if (found && !EMPTY.has(found.name)) blocks.push({ pos, block: found });
      }
      for (const entry of blocks) if (entry.block.diggable === false || entry.block.name === "void_air") throw skillError("台阶空间不可安全清理", "unsafe_navigation", { pos: entry.pos });
      if (await this.#stepSupport(support, block)) placed++;
      for (const entry of blocks.sort((a, b) => b.pos[1] - a.pos[1])) {
        const current = await this.#block(entry.pos);
        if (EMPTY.has(current?.name)) continue;
        if (!current?.name || protectedBlock(current) || FLUIDS.has(current.name) || current.diggable === false) throw skillError("施工方块发生变化，停止并重新观察", "unsafe_navigation", { pos: entry.pos, block: current?.name });
        await this.api.dig({ pos: entry.pos, collect: false });
        dug += 1;
      }
      feet = await this.#moveStep(nextFeet);
      onProgress({ mode: "staircase", completed: step + 1, total: count, dug, placed, pos: feet });
    }
    return { mode: "staircase", steps: count, dug, placed, position: feet };
  }

  async staircaseUp({ origin, target = null, direction, steps = 2, block = "cobblestone", preferDirect = false, onProgress = () => {} } = {}) {
    const current = await this.#status();
    if (target && !Array.isArray(target)) target = [target.x, target.y, target.z];
    direction ||= target ? this.#direction(floorPos(current.pos), { x: target[0], z: target[2] }) : "z";
    const vector = CARDINALS[direction];
    if (!vector) throw skillError("direction 必须为 x、-x、z 或 -z", "bad_args");
    const status = current;
    if (origin && Math.hypot(...origin.map((value, axis) => value - status.pos[axis])) > 1.5) throw skillError("楼梯起点必须是角色实际位置", "bad_args");
    let feet = origin ? floorPos(origin) : floorPos(status.pos);
    // Ascend one or two levels per invocation so every block remains within
    // reach and the next segment can be replanned from the actual position.
    const count = Math.min(2, Number.isFinite(target?.[1]) && target[1] > feet[1] ? Math.max(1, Math.floor(target[1]) - feet[1]) : 2, Math.max(1, Number(steps) || 2));
    const directGoal = Array.isArray(target) && target.length >= 3
      ? floorPos(target)
      : add(feet, [vector[0] * count, count, vector[2] * count]);
    if (preferDirect) {
      if (await this.#tryDirect(directGoal)) return { mode: "direct", reached: true, position: directGoal };
      const actual = floorPos((await this.#status()).pos);
      if (actual.some((v, i) => v !== feet[i])) throw skillError("普通寻路产生部分位移，请从实际位置重新观察后施工", "navigation_failed", { actual, previous: feet });
    }
    let dug = 0, placed = 0;
    for (let step = 0; step < count; step += 1) {
      const nextFeet = add(feet, [vector[0], 1, vector[2]]);
      const head = add(nextFeet, [0, 1, 0]);
      const support = add(nextFeet, [0, -1, 0]);
      const blocks = [];
      // A one-block rise needs a three-block-high vertical column cleared at
      // the new x/z position: feet, head, and one extra block above the head.
      for (const pos of [add(feet, [0, 2, 0]), nextFeet, head, add(nextFeet, [0, 2, 0])]) {
        const found = await this.#block(pos);
        if (!found?.name) throw skillError("上行空间尚未确认，停止挖掘", "unknown_block", { pos });
        if (protectedBlock(found)) throw skillError("楼梯会破坏重要设施，停止施工", "unsafe_navigation", { pos, block: found.name });
        if (found && FLUIDS.has(found.name)) throw skillError(`上行台阶内发现 ${found.name}，停止挖掘`, "unsafe_navigation", { pos, block: found.name });
        if (found && !EMPTY.has(found.name)) blocks.push({ pos, block: found });
      }
      for (const entry of blocks) if (entry.block.name === "bedrock" || entry.block.name === "void_air" || entry.block.diggable === false) throw skillError(`无法安全挖掘 ${entry.block.name}`, "undiggable", { pos: entry.pos });
      if (await this.#stepSupport(support, block)) placed++;
      for (const entry of blocks.sort((a, b) => b.pos[1] - a.pos[1])) {
        const current = await this.#block(entry.pos);
        if (EMPTY.has(current?.name)) continue;
        if (!current?.name || protectedBlock(current) || FLUIDS.has(current.name) || current.diggable === false) throw skillError("施工方块发生变化，停止并重新观察", "unsafe_navigation", { pos: entry.pos, block: current?.name });
        await this.api.dig({ pos: entry.pos, collect: false });
        dug += 1;
      }
      feet = await this.#moveStep(nextFeet);
      onProgress({ mode: "staircase_up", completed: step + 1, total: count, dug, placed, pos: feet });
    }
    return { mode: "staircase_up", steps: count, dug, placed, position: feet };
  }
}
