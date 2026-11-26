import { addPos, skillError } from "./helpers.js";

const DIRECTIONS = {
  x: { forward: [1, 0, 0], side: [0, 0, 1] },
  z: { forward: [0, 0, 1], side: [1, 0, 0] }
};

async function digIfPresent({ api, executor, pos, collect = true, requireType, block: knownBlock = null }) {
  const block = knownBlock || (await api.getBlock({ pos })).result;
  if (!block || block.name === "air" || (requireType && !requireType.has(block.name))) return false;
  if (block.diggable === false) return false;
  await executor.enqueue({ type: "dig", params: { pos, collect } }, { source: "skill:mining", priority: 10, attempts: 1 });
  return true;
}

async function scanAndQueue({ api, executor, positions, requireType = null, collect = true }) {
  const blocks = await Promise.all(positions.map(pos => api.getBlock({ pos })));
  const valid = positions.filter((pos, index) => {
    const block = blocks[index]?.result;
    return block && block.name !== "air" && (!requireType || requireType.has(block.name)) && block.diggable !== false;
  });
  if (!valid.length) return 0;
  const actions = valid.map(pos => ({ type: "dig", params: { pos, collect, single: true } }));
  if (typeof executor.enqueueBatch === "function") {
    await executor.enqueueBatch(actions, { source: "skill:mining", priority: 10, attempts: 1 });
  } else {
    for (const action of actions) await executor.enqueue(action, { source: "skill:mining", priority: 10, attempts: 1 });
  }
  return valid.length;
}

/** Creates a two-high main tunnel with alternating side branches. */
export class FishboneMiningScript {
  constructor({ api, executor }) {
    this.api = api;
    this.executor = executor;
  }

  async run({ origin, direction = "z", length = 32, branchLength = 8, branchEvery = 3, yOffset = 0 } = {}) {
    if (!origin || !DIRECTIONS[direction]) throw skillError("origin and direction are required", "bad_args");
    const axis = DIRECTIONS[direction];
    const start = [Math.floor(origin[0]), Math.floor(origin[1] + yOffset), Math.floor(origin[2])];
    let dug = 0;
    for (let step = 0; step < length; step += 1) {
      const center = addPos(start, [axis.forward[0] * step, 0, axis.forward[2] * step]);
      dug += await scanAndQueue({ api: this.api, executor: this.executor, positions: [center, addPos(center, [0, 1, 0])] });
      if (step > 0 && step % branchEvery === 0) {
        for (const sideSign of [-1, 1]) {
          const branchPositions = [];
          for (let branch = 1; branch <= branchLength; branch += 1) {
            const sidePos = addPos(center, [axis.side[0] * sideSign * branch, 0, axis.side[2] * sideSign * branch]);
            branchPositions.push(sidePos, addPos(sidePos, [0, 1, 0]));
          }
          dug += await scanAndQueue({ api: this.api, executor: this.executor, positions: branchPositions });
        }
      }
    }
    return { dug, origin: start, direction, length, branchLength, branchEvery };
  }
}

/** Mines a connected set of explicitly discoverable blocks without x-ray. */
export class VeinMiningScript {
  constructor({ api, executor }) {
    this.api = api;
    this.executor = executor;
  }

  async run({ types, origin, radius = 16, maxBlocks = 64 } = {}) {
    if (!Array.isArray(types) || !types.length) throw skillError("types are required", "bad_args");
    const wanted = new Set(types);
    const initial = origin ? [(await this.api.getBlock({ pos: origin })).result] : (await this.api.findBlocks({ types, radius, limit: maxBlocks })).result?.blocks || [];
    const queue = initial.filter(Boolean).filter(block => wanted.has(block.name)).map(block => block.pos);
    const seen = new Set(queue.map(pos => pos.join(",")));
    let dug = 0;
    let scanned = 0;
    const scanBudget = Math.max(maxBlocks * 12, 64);
    const center = origin || queue[0];
    if (!center) return { dug, scanned, types, maxBlocks };
    const offsets = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    while (queue.length && dug < maxBlocks && scanned < scanBudget) {
      const pos = queue.shift();
      if (Math.hypot(pos[0] - center[0], pos[1] - center[1], pos[2] - center[2]) > radius) continue;
      scanned += 1;
      const block = (await this.api.getBlock({ pos })).result;
      if (!block || !wanted.has(block.name) || block.diggable === false) continue;
      if (await digIfPresent({ api: this.api, executor: this.executor, pos, requireType: wanted, block })) dug += 1;
      for (const offset of offsets) {
        const next = addPos(pos, offset);
        const key = next.join(",");
        if (!seen.has(key)) {
          seen.add(key);
          queue.push(next);
        }
      }
    }
    return { dug, scanned, types, maxBlocks };
  }
}
