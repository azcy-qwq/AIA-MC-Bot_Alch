import { EventBus } from "../core/events.js";
import { withRetry } from "../core/rate-limit.js";
import { summarizeEnvironment } from "../core/environment-summary.js";
import { checkCraftRequirements } from "./recipe-checker.js";
import { normalizeEquipParams } from "./equip-normalizer.js";
import { passableCell, protectedBlock, solidSupport } from "../core/spatial-observer.js";
import { resolveStandDestination } from "../navigation/safe-destination.js";

const API_METHODS = {
  move_to: "moveTo", dig: "dig", place: "place", interact: "interact", use_item: "useItem",
  attack: "attack", shoot: "shoot", craft: "craft", window_view: "windowView", window_act: "windowAct",
  equip: "equip", posture: "posture", dismount: "dismount", drop: "drop", control: "control", look: "look"
};
const QUICK_ACTION_TIMEOUTS = { craft: 10000, equip: 10000, posture: 5000, window_view: 10000, window_act: 10000 };
const COMMON_BLOCK_BUDGET = { stone: 12, cobblestone: 12, deepslate: 12, cobbled_deepslate: 12, andesite: 8, diorite: 8, granite: 8, tuff: 8 };
const SKILL_ACTIONS = new Set(["jump_attack", "navigation_recover", "bridge_to", "ladder_climb", "staircase_down", "staircase_up", "route_navigate", "flatten_area", "chop_tree", "mine_vein", "fishbone_mine"]);
export const LONG_WORK_ACTIONS = new Set(["chop_tree", "mine_vein", "fishbone_mine"]);
const cleanItemName = value => String(value || "").trim().replace(/^minecraft:/i, "");

function normalizeNavigationParams(type, input = {}) {
  if (!["navigation_recover", "bridge_to", "ladder_climb", "staircase_up", "staircase_down"].includes(type)) return input;
  const params = input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {};
  const candidate = Array.isArray(input) ? input : params.target ?? params.pos ?? params.destination;
  if (Array.isArray(candidate) && candidate.length >= 3) {
    params.target = candidate.slice(0, 3).map(Number);
  } else if (candidate && typeof candidate === "object" && Number.isFinite(Number(candidate.x)) && Number.isFinite(Number(candidate.z))) {
    params.target = { x: Number(candidate.x), y: Number.isFinite(Number(candidate.y)) ? Number(candidate.y) : undefined, z: Number(candidate.z) };
  }
  delete params.pos;
  delete params.destination;
  // The model sometimes emits {pos:[...]} for skill actions.  Recover and
  // staircase skills share the same target contract, so normalize it before
  // invoking the deterministic skill handler.
  if (type === "navigation_recover" && !params.target) return params;
  return params;
}

function countInventoryItem(inventory, itemName) {
  const wanted = cleanItemName(itemName);
  if (!wanted) return 0;
  const stacks = [
    ...(inventory?.items || []),
    inventory?.held,
    inventory?.offhand,
    inventory?.armor?.head,
    inventory?.armor?.chest,
    inventory?.armor?.legs,
    inventory?.armor?.feet
  ].filter(Boolean);
  const seen = new Set();
  return stacks.filter(stack => {
    if (cleanItemName(stack.name) !== wanted) return false;
    const key = stack.slot === undefined ? stack : `slot:${stack.slot}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).reduce((sum, stack) => sum + Math.max(0, Number(stack.count ?? 1)), 0);
}

export class ActionExecutor {
  constructor({ api, worldModel, eventBus = new EventBus(), retryDelayMs = 100 }) {
    this.api = api;
    this.worldModel = worldModel;
    this.events = eventBus;
    this.retryDelayMs = Math.max(0, Number(retryDelayMs) || 0);
    this.queue = [];
    this.running = null;
    this.sequence = 0;
    this.paused = false;
    this.minedByType = new Map();
    this.batches = new Map();
    this.skillActions = new Map();
    this.lastFailure = null;
    this.workProgress = null;
  }

  get busy() { return Boolean(this.running); }
  get queueLength() { return this.queue.length; }
  get currentAction() { return this.running?.action || null; }

  registerSkillAction(name, handler) {
    if (!SKILL_ACTIONS.has(name)) throw new Error(`Skill action is not allowed: ${name}`);
    this.skillActions.set(name, handler);
  }

  enqueue(action, { priority = 0, source = "strategy", attempts = 2, batchId = null } = {}) {
    const promise = new Promise((resolve, reject) => {
      if (this.paused) {
        reject(Object.assign(new Error("Actions are paused while waiting for respawn"), { code: "cancelled" }));
        return;
      }
      if (batchId && this.batches?.get(batchId)?.failed) {
        reject(Object.assign(new Error("Batch cancelled after an earlier action failed"), { code: "cancelled" }));
        return;
      }
      this.queue.push({ action, priority, source, attempts, batchId, resolve, reject, sequence: this.sequence++, queuedAt: Date.now() });
      this.queue.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
      this.#drain();
    });
    // Tac and death recovery intentionally cancel queued work. Marking the
    // returned promise as handled prevents a cancelled queue item from taking
    // down the debug process when its caller is no longer awaiting it.
    promise.catch(() => {});
    return promise;
  }

  /** Queue every action immediately; API execution remains strictly serial. */
  async enqueueBatch(actions = [], { priority = 0, source = "strategy", attempts = 2, batchId = `batch-${Date.now()}-${this.sequence}` } = {}) {
    this.batches ||= new Map();
    this.batches.set(batchId, { failed: false });
    const promises = actions.map(action => this.enqueue(action, { priority, source, attempts, batchId }));
    const settled = await Promise.allSettled(promises);
    this.batches.delete(batchId);
    const failed = settled.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
    return settled.map(result => result.value);
  }

  async #drain() {
    if (this.paused || this.running || !this.queue.length) return;
    const item = this.queue.shift();
    this.running = item;
    const currentSnapshot = this.worldModel?.latest || {};
    const startedAt = Date.now();
    item.startedAt = startedAt;
    this.events.emit("action-start", { action: item.action, source: item.source, batchId: item.batchId, queuedAt: item.queuedAt, startedAt, queueWaitMs: startedAt - item.queuedAt, queueLength: this.queue.length, context: summarizeEnvironment(currentSnapshot, "action") });
    try {
      const execute = () => this.#execute(item.action, progress => this.events.emit("action-progress", { action: item.action, source: item.source, progress, elapsedMs: Date.now() - startedAt }), item.source);
      const timeoutMs = QUICK_ACTION_TIMEOUTS[item.action?.type];
      const timedExecute = () => {
        if (!timeoutMs) return execute();
        let timer;
        return Promise.race([
          execute(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`${item.action.type} 超时（>${timeoutMs}ms）`), { code: "action_timeout" })), timeoutMs); })
        ]).finally(() => clearTimeout(timer));
      };
      const result = await withRetry(() => timedExecute(), {
        attempts: item.attempts,
        baseDelayMs: this.retryDelayMs,
        shouldRetry: error => !this.paused && error.code === "busy"
      });
      item.resolve(result);
      this.lastFailure = null;
      this.events.emit("action-end", { action: item.action, source: item.source, batchId: item.batchId, result, durationMs: Date.now() - startedAt, queueWaitMs: startedAt - item.queuedAt, queueLength: this.queue.length, context: summarizeEnvironment(this.worldModel?.latest || {}, "action") });
    } catch (error) {
      if (item.batchId && this.batches?.has(item.batchId)) {
        const batch = this.batches.get(item.batchId);
        batch.failed = true;
        for (const pending of this.queue.filter(candidate => candidate.batchId === item.batchId)) {
          pending.reject(Object.assign(new Error("Batch cancelled after an earlier action failed"), { code: "cancelled" }));
        }
        this.queue = this.queue.filter(candidate => candidate.batchId !== item.batchId);
      }
      this.lastFailure = { action: item.action?.type, code: error?.code || "", at: Date.now() };
      item.reject(error);
      this.events.emit("action-error", { action: item.action, source: item.source, batchId: item.batchId, error, durationMs: Date.now() - startedAt, queueWaitMs: startedAt - item.queuedAt, queueLength: this.queue.length, context: summarizeEnvironment(this.worldModel?.latest || {}, "action") });
    } finally {
      this.running = null;
      this.#drain();
    }
  }

  async #execute(action, onProgress = () => {}, source = "") {
    if (!action?.type) throw new Error("Action type is required");
    if (action.type === "move_to") {
      const raw = action.params || {};
      let params = { ...raw };
      const target = params.pos || params.target;
      if (Array.isArray(target) && target.length === 3) [params.x, params.y, params.z] = target.map(Number);
      delete params.pos; delete params.target;
      if (!params.entity_id && (!Number.isFinite(params.x) || !Number.isFinite(params.z))) throw Object.assign(new Error("move_to 需要 x/z 或完整目标坐标"), { code: "bad_args" });
      if (!params.entity_id && this.api.getBlock && this.api.status) {
        const status = (await this.api.status()).result;
        if (!status?.in_vehicle) {
          const resolved = await resolveStandDestination(this.api, params, status?.pos);
          if (JSON.stringify(resolved) !== JSON.stringify(params)) this.events.emit("action-normalized", { source, original: action, normalized: resolved, reason: "supported_destination_with_two_clear_cells" });
          params = resolved;
        }
      }
      if (Number.isFinite(params.y) && params.range === undefined) params.range = 0.3;
      delete params.exact;
      const result = await this.api.moveTo(params);
      if (!params.entity_id) {
        const actual = result?.result?.pos || result?.pos || (this.api.status ? (await this.api.status()).result?.pos : null);
        const range = Number(params.range ?? 1);
        const sameBlock = actual && Math.floor(actual[0]) === Math.floor(params.x) && Math.floor(actual[2]) === Math.floor(params.z);
        const sameHeight = !Number.isFinite(params.y) || (Number.isFinite(actual?.[1]) && Math.floor(actual[1]) === Math.floor(params.y));
        // The API reports the player's fractional feet position. Validate the
        // occupied voxel; fractional Y values within the requested floor are
        // normal and must not trigger false navigation failures.
        if (actual && (!sameBlock || !sameHeight)) {
          throw Object.assign(new Error("寻路返回成功但实际位置未到达目标，先重新观察再规划"), { code: "navigation_failed", details: { target: params, actual } });
        }
      }
      return result;
    }
    if (this.skillActions.has(action.type)) {
      const params = normalizeNavigationParams(action.type, action.params || {});
      const controller = new AbortController();
      this.skillController = controller;
      if (LONG_WORK_ACTIONS.has(action.type)) this.workProgress = { nearEnd: false, startedAt: Date.now(), type: action.type };
      const checked = () => { if (controller.signal.aborted || this.paused) throw Object.assign(new Error("Script cancelled"), { code: "cancelled" }); };
      const runAction = async step => {
        checked();
        const result = await this.#execute(step, onProgress, `script:${action.type}`);
        checked();
        return result;
      };
      try {
        return await this.skillActions.get(action.type)(params, progress => {
          checked();
          if (LONG_WORK_ACTIONS.has(action.type)) this.workProgress = { ...this.workProgress, ...progress };
          onProgress(progress);
        }, { signal: controller.signal, runAction });
      } finally {
        if (this.skillController === controller) this.skillController = null;
        if (LONG_WORK_ACTIONS.has(action.type)) this.workProgress = null;
      }
    }
    if (action.type === "craft") {
      const params = action.params || {};
      const inventoryResult = await this.api.inventory();
      const check = checkCraftRequirements(inventoryResult.result, params.item, params.count, params.requirements);
      const preflight = {
        source,
        action,
        ok: check.ok,
        known: check.known,
        item: params.item,
        requested: Math.max(1, Math.floor(Number(params.count) || 1)),
        crafts: check.crafts,
        outputPerCraft: check.outputPerCraft,
        missing: check.missing,
        inventory: inventoryResult.result
      };
      this.events.emit("action-preflight", preflight);
      if (!check.ok) throw Object.assign(new Error(`材料不足，无法合成 ${params.item}`), { code: "missing_ingredients", details: preflight });
    }
    if (action.type === "equip") {
      const inventoryResult = this.api.inventory ? await this.api.inventory() : null;
      const inventory = inventoryResult?.result || this.worldModel?.latest?.inventory || null;
      const normalized = normalizeEquipParams(action.params || {}, inventory);
      this.events.emit("action-normalized", { source, original: action, normalized, reason: "equip_schema" });
      const result = await this.api.equip(normalized);
      if (this.api.status) {
        let observed = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          observed = (await this.api.status()).result || {};
          const slotName = normalized.slot === "hand" ? "held" : normalized.slot === "off-hand" ? "offhand" : "armor";
          const source = Object.prototype.hasOwnProperty.call(observed, slotName)
            ? observed
            : this.worldModel?.latest?.status || observed;
          const actual = slotName === "armor" ? source.armor?.[normalized.slot === "torso" ? "chest" : normalized.slot] : source[slotName];
          // A client may expose an older status schema; only enforce the
          // check when the slot is present. Explicit null means the server
          // confirmed that the requested slot is still empty.
          if (actual !== undefined && actual?.name === normalized.item) return result;
          if (actual === undefined) {
            if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100));
            continue;
          }
          if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw Object.assign(new Error(`装备调用返回成功但 ${normalized.slot} 槽位仍不是 ${normalized.item}`), { code: "equip_not_applied", details: { requested: normalized, observed } });
      }
      return result;
    }
    if (["place", "use_item", "drop"].includes(action.type)) {
      const params = action.params || {};
      const item = cleanItemName(params.item);
      if (!item) throw Object.assign(new Error(`${action.type} 需要提供物品名称`), { code: "bad_args" });
      const inventoryResult = this.api.inventory ? await this.api.inventory() : null;
      const inventory = inventoryResult?.result || this.worldModel?.latest?.inventory || null;
      const required = Math.max(1, Number(params.count) || 1);
      const available = countInventoryItem(inventory, item);
      if (available < required) {
        throw Object.assign(new Error(`物品不足，无法执行 ${action.type}：${item}`), {
          code: "missing_item",
          details: { item, required, available, action: action.type, inventory }
        });
      }
      this.events.emit("action-preflight", { source, action, ok: true, item, required, available });
      if (action.type === "place" && this.api.getBlock && Array.isArray(params.pos)) {
        const targetBlock = (await this.api.getBlock({ pos: params.pos })).result;
        if (!targetBlock?.name) throw Object.assign(new Error("放置目标格未确认，先观察再放置"), { code: "unknown_block", details: { pos: params.pos } });
        if (!passableCell(targetBlock)) throw Object.assign(new Error(`${targetBlock.name} already at target`), { code: "occupied", details: { pos: params.pos, block: targetBlock.name } });
        const [x, y, z] = params.pos.map(Number);
        const neighbours = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
        const supports = await Promise.all(neighbours.map(([dx, dy, dz]) => this.api.getBlock({ pos: [x + dx, y + dy, z + dz] })));
        if (!supports.some(response => solidSupport(response?.result))) throw Object.assign(new Error("no solid neighbour block to place against"), { code: "no_support", details: { pos: params.pos } });
      }
    }
    if (action.type === "interact") {
      try {
        return await this.api.interact(action.params || {});
      } catch (error) {
        if (error.code !== "use_window_api") throw error;
        const params = action.params || {};
        const target = params.pos ? { pos: params.pos } : params.entity_id ? { entity_id: params.entity_id } : params.block ? { block: params.block } : null;
        if (!target) throw error;
        this.events.emit("action-recovery", { from: "interact", to: "window_view", reason: error.code, target });
        return this.api.windowView({ target });
      }
    }
    if (action.type === "window_act") {
      const params = action.params || {};
      if (!Array.isArray(params.ops) || params.ops.length === 0) {
        throw Object.assign(new Error("window_act 需要至少一个有效 ops 操作；先用 window_view 确认窗口分区"), { code: "bad_args", details: { field: "ops" } });
      }
      const invalid = params.ops.find(op => !op || typeof op !== "object" || !["put", "take", "select", "text"].includes(op.op));
      if (invalid) throw Object.assign(new Error("window_act.ops 包含无效操作"), { code: "bad_args", details: { op: invalid } });
    }
    const planSource = source.startsWith("strategy:") || source.startsWith("action:");
    // Construction must preserve its exact geometry. Only explicit resource
    // harvesting may expand beyond the requested block.
    const explicitContinuous = action.params?.continuous === true || action.params?.maxBlocks > 1;
    if (action.type === "mine_continuous" || (action.type === "dig" && planSource && explicitContinuous && action.params?.purpose !== "staircase" && action.params?.single !== true)) {
      return this.#digContinuous(action.params || {}, onProgress);
    }
    if (action.type === "dig") return this.#digChecked(action.params || {});
    if (action.type === "dig_nearest") {
      const found = await this.api.findBlocks(action.params || {});
      const block = found.result?.blocks?.[0];
      if (!block) throw Object.assign(new Error("No matching block found"), { code: "nothing_to_dig" });
      if (block.diggable === false) throw Object.assign(new Error("Target block is not diggable"), { code: "undiggable" });
      if (planSource && action.params?.single !== true && action.params?.purpose !== "staircase") return this.#digContinuous({ ...action.params, pos: block.pos }, onProgress);
      return this.#digChecked({ ...action.params, pos: block.pos });
    }
    if (action.type === "dig_many") {
      const params = action.params || {};
      const requestedLimit = Math.min(32, Math.max(1, Number(params.limit) || 4));
      const blockType = params.types?.[0];
      const budget = COMMON_BLOCK_BUDGET[blockType];
      const explicitPurpose = params.bulk === true || ["mine", "staircase", "bridge"].includes(params.purpose);
      const remainingBudget = budget === undefined || explicitPurpose ? requestedLimit : Math.max(0, budget - (this.minedByType.get(blockType) || 0));
      const limit = Math.min(requestedLimit, remainingBudget);
      if (limit === 0) throw Object.assign(new Error(`基础方块 ${blockType} 已达到采集上限`), { code: "common_block_budget_exhausted", details: { block: blockType, budget } });
      let positions = Array.isArray(params.positions) ? params.positions.slice(0, limit) : null;
      if (!positions) {
        const found = await this.api.findBlocks({ types: params.types, radius: params.radius ?? 16, limit });
        positions = (found.result?.blocks || []).slice(0, limit).map(block => block.pos);
      }
      if (!positions.length) throw Object.assign(new Error("No matching blocks found"), { code: "nothing_to_dig" });
      const results = [];
      for (let index = 0; index < positions.length; index += 1) {
        const result = await this.#digChecked({ ...params, pos: positions[index] });
        results.push({ pos: positions[index], result });
        if (blockType && budget !== undefined && !explicitPurpose) this.minedByType.set(blockType, (this.minedByType.get(blockType) || 0) + 1);
        onProgress({ completed: index + 1, total: positions.length, pos: positions[index] });
      }
      return { dug: results.length, results };
    }
    const method = API_METHODS[action.type];
    if (!method || typeof this.api[method] !== "function") throw new Error(`Unsupported action: ${action.type}`);
    return this.api[method](action.params || {});
  }

  async #digChecked(params) {
    const pos = params.pos;
    if (!Array.isArray(pos) || pos.length !== 3 || !pos.every(Number.isFinite)) throw Object.assign(new Error("挖掘需要明确的 [x,y,z] 坐标"), { code: "bad_args" });
    if (this.api.getBlock) {
      const block = (await this.api.getBlock({ pos })).result;
      if (!block?.name) throw Object.assign(new Error("目标方块未被确认，先观察再挖掘"), { code: "unknown_block" });
      if (passableCell(block) && /^(air|cave_air)$/.test(block.name)) return { ok: true, result: { skipped: "already_clear", pos } };
      if (protectedBlock(block) || /^(lava|water|flowing_lava|flowing_water|bubble_column|void_air)$/.test(block.name) || block.diggable === false) {
        throw Object.assign(new Error(`不能为普通挖掘破坏重要或危险方块 ${block.name}`), { code: "unsafe_excavation" });
      }
    }
    const result = await this.api.dig({ pos, collect: params.collect !== false });
    await this.#collectNearbyOres(pos);
    return result;
  }

  async #collectNearbyOres(origin) {
    if (!this.api.findBlocks || !this.api.getBlock) return;
    const types = ["coal_ore", "deepslate_coal_ore", "iron_ore", "deepslate_iron_ore", "copper_ore", "deepslate_copper_ore", "gold_ore", "deepslate_gold_ore", "redstone_ore", "deepslate_redstone_ore", "lapis_ore", "deepslate_lapis_ore", "diamond_ore", "deepslate_diamond_ore", "emerald_ore", "deepslate_emerald_ore", "nether_quartz_ore", "nether_gold_ore"];
    try {
      const found = await this.api.findBlocks({ types, radius: 4, limit: 16 });
      const seen = new Set();
      for (const block of found.result?.blocks || []) {
        const pos = block?.pos;
        if (!Array.isArray(pos) || pos.length !== 3 || pos.some(value => !Number.isFinite(value))) continue;
        const key = pos.join(",");
        if (seen.has(key) || Math.hypot(pos[0] - origin[0], pos[1] - origin[1], pos[2] - origin[2]) > 3.5) continue;
        seen.add(key);
        const current = (await this.api.getBlock({ pos })).result;
        if (!current?.name?.includes("_ore") || current.diggable === false || protectedBlock(current)) continue;
        let exposed = false;
        for (const offset of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const adjacent = [pos[0] + offset[0], pos[1] + offset[1], pos[2] + offset[2]];
          const neighbor = (await this.api.getBlock({ pos: adjacent })).result;
          if (neighbor && /^(air|cave_air)$/.test(neighbor.name || "")) { exposed = true; break; }
        }
        if (!exposed) continue;
        await this.api.dig({ pos, collect: true });
      }
    } catch {
      // Incidental ore collection must never interrupt the requested dig.
    }
  }

  async #digContinuous(params, onProgress) {
    const requestedMax = Math.min(16, Math.max(1, Number(params.maxBlocks ?? params.limit ?? 6)));
    const radius = Math.min(64, Math.max(1, Number(params.radius ?? 16)));
    const seen = new Set();
    const results = [];
    let types = Array.isArray(params.types) && params.types.length ? params.types : null;
    const startPos = Array.isArray(params.pos) ? params.pos : null;

    if (startPos && this.api.getBlock) {
      const block = (await this.api.getBlock({ pos: startPos })).result;
      if (!block || block.name === "air") throw Object.assign(new Error("Target block is unavailable"), { code: "nothing_to_dig" });
      if (block.diggable === false) throw Object.assign(new Error(`目标方块 ${block.name} 不可挖掘`), { code: "undiggable" });
      if (!types) types = [block.name];
    }
    const blockType = types?.[0];
    const budget = COMMON_BLOCK_BUDGET[blockType];
    const explicitlyMining = params.bulk === true || params.purpose === "mine" || params.purpose === "staircase" || params.purpose === "bridge";
    const remainingBudget = budget === undefined || explicitlyMining ? requestedMax : Math.max(0, budget - (this.minedByType.get(blockType) || 0));
    const maxBlocks = Math.min(requestedMax, remainingBudget);
    if (maxBlocks === 0) throw Object.assign(new Error(`基础方块 ${blockType} 已达到采集上限；需明确声明用途才能继续开采`), { code: "common_block_budget_exhausted", details: { block: blockType, budget } });

    const dig = async pos => {
      const key = pos.join(",");
      if (seen.has(key) || results.length >= maxBlocks) return;
      seen.add(key);
      const result = await this.#digChecked({ ...params, pos });
      results.push({ pos, result });
      if (blockType && COMMON_BLOCK_BUDGET[blockType] !== undefined && !explicitlyMining) this.minedByType.set(blockType, (this.minedByType.get(blockType) || 0) + 1);
      onProgress({ completed: results.length, total: maxBlocks, pos, mode: "continuous" });
    };

    if (Array.isArray(params.positions)) {
      for (const pos of params.positions.slice(0, maxBlocks)) await dig(pos);
    } else {
      if (startPos) await dig(startPos);
      if (this.api.findBlocks && results.length < maxBlocks) {
        const found = await this.api.findBlocks({ types: types || undefined, radius, limit: Math.min(32, maxBlocks * 2) });
        const candidates = (found.result?.blocks || []).filter(block => block?.pos && block.name !== "air" && block.diggable !== false && !seen.has(block.pos.join(",")));
        if (!types && candidates[0]) types = [candidates[0].name];
        // Grow a connected vein/tree cluster, never a nearest-block sweep
        // across unrelated walls, floors and supports.
        while (candidates.length && results.length < maxBlocks) {
          const index = candidates.findIndex(block => !seen.size || [...seen].some(point => point.split(",").reduce((n, value, axis) => n + Math.abs(Number(value) - block.pos[axis]), 0) === 1));
          if (index < 0) break;
          const [block] = candidates.splice(index, 1);
          await dig(block.pos);
        }
      }
    }
    if (!results.length) throw Object.assign(new Error("No matching blocks found"), { code: "nothing_to_dig" });
    return { dug: results.length, continuous: true, results };
  }

  async stop() {
    this.skillController?.abort();
    if (this.api.stop) await this.api.stop();
  }

  cancelPending(reason = "Actions cancelled") {
    this.skillController?.abort();
    const error = Object.assign(new Error(reason), { code: "cancelled" });
    for (const item of this.queue.splice(0)) item.reject(error);
    for (const batch of this.batches?.values() || []) batch.failed = true;
  }

  pause() { this.paused = true; this.skillController?.abort(); }
  resume() { this.paused = false; this.#drain(); }
}

export class PlanRunner {
  constructor({ executor, eventBus = new EventBus() }) {
    this.executor = executor;
    this.events = eventBus;
    this.running = null;
    this.queuedPlan = null;
    this.activeSignature = null;
    this.queuedSignature = null;
    this.activeTask = null;
    this.activePlanId = null;
    this.completedActions = [];
    this.currentAction = null;
    this.pendingRevision = null;
  }

  snapshot() {
    return { planId: this.activePlanId, activeTask: this.activeTask ? { id: this.activeTask.id, title: this.activeTask.title, goal: this.activeTask.goal } : null,
      completedActions: this.completedActions, currentAction: this.currentAction, queuedPlanId: this.queuedPlan?.planId || null };
  }

  submit(plan) {
    const signature = JSON.stringify((plan?.tasks || []).slice(0, 1).map(task => ({ title: task.title, actions: task.actions })));
    if (this.running) {
      if (signature === this.activeSignature || signature === this.queuedSignature) return false;
      if (plan.continuesTaskId && plan.continuesTaskId === this.activeTask?.id) {
        this.pendingRevision = plan;
        this.events.emit("plan-improved", { planId: plan.planId, taskId: this.activeTask.id, message: "当前动作结束后更新剩余步骤" });
        return false;
      }
      this.queuedPlan = plan;
      this.queuedSignature = signature;
      this.events.emit("plan-queued", { planId: plan?.planId, task: plan?.tasks?.[0]?.title });
      return false;
    }
    this.activeSignature = signature;
    this.running = this.#run(plan).finally(() => {
      this.running = null;
      this.activeSignature = null;
      const next = this.queuedPlan;
      this.queuedPlan = null;
      this.queuedSignature = null;
      if (next) this.submit(next);
    });
    return true;
  }

  run(plan) { return this.#run(plan); }

  cancel() {
    this.queuedPlan = null;
    this.queuedSignature = null;
    this.pendingRevision = null;
    this.generation = (this.generation || 0) + 1;
  }

  async #run(plan) {
    const generation = this.generation || 0;
    const results = [];
    for (const task of plan?.tasks || []) {
      if (generation !== (this.generation || 0) || this.executor.paused) break;
      this.activeTask = task;
      this.activePlanId = plan.planId;
      this.completedActions = [];
      this.events.emit("task-start", { taskId: task.id, planId: plan.planId, task });
      let success = false;
      let lastError;
      let actions = [...task.actions];
      for (let attempt = 0; attempt < task.maxAttempts && !success; attempt += 1) {
        try {
          const taskResults = [];
          while (actions.length) {
            if (generation !== (this.generation || 0) || this.executor.paused) throw Object.assign(new Error("Plan cancelled"), { code: "cancelled" });
            const batch = actions.slice();
            this.currentAction = batch[0];
            const batchResults = typeof this.executor.enqueueBatch === "function"
              ? await this.executor.enqueueBatch(batch, { source: `action:${task.id}`, attempts: 1, batchId: `${plan.planId || "plan"}:${task.id}:${attempt}` })
              : [];
            if (typeof this.executor.enqueueBatch !== "function") {
              for (const action of batch) batchResults.push(await this.executor.enqueue(action, { source: `action:${task.id}`, attempts: 1 }));
            }
            taskResults.push(...batchResults);
            this.completedActions.push(...batch);
            actions.splice(0, batch.length);
            this.currentAction = null;
            if (this.pendingRevision?.continuesTaskId === task.id) {
              const revision = this.pendingRevision;
              this.pendingRevision = null;
              const completed = this.completedActions.map(item => JSON.stringify(item));
              actions = revision.tasks[0].actions.filter(item => {
                const index = completed.indexOf(JSON.stringify(item));
                if (index < 0) return true;
                completed.splice(index, 1);
                return false;
              });
              this.activeTask = { ...task, actions };
            }
          }
          results.push({ taskId: task.id, planId: plan.planId, ok: true, attempt: attempt + 1, results: taskResults });
          this.events.emit("task-complete", results.at(-1));
          success = true;
        } catch (error) {
          lastError = error;
          const reobserve = ["cancelled", "path_not_found", "navigation_failed", "stalled", "unreachable", "unsafe_navigation", "navigation_recovery_not_allowed", "no_support", "occupied", "nothing_to_dig", "missing_item", "missing_ingredients", "bad_args", "undiggable"].includes(error.code);
          this.events.emit("task-error", { taskId: task.id, planId: plan.planId, attempt: attempt + 1, final: reobserve || attempt + 1 >= task.maxAttempts, error });
          if (reobserve || generation !== (this.generation || 0)) break;
        }
      }
      if (!success) results.push({ taskId: task.id, ok: false, error: lastError });
      this.activeTask = null;
      this.activePlanId = null;
      this.currentAction = null;
      this.pendingRevision = null;
    }
    return results;
  }
}
