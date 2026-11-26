import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { floorPos, itemNames, skillError } from "./helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EMPTY = new Set(["air", "cave_air", "void_air"]);
const PROTECTED = new Set(["bedrock", "barrier", "lava", "flowing_lava", "water", "flowing_water", "bubble_column"]);
const DEFAULT_TERRAIN = new Set(["dirt", "grass_block", "coarse_dirt", "podzol", "rooted_dirt", "stone", "cobblestone", "deepslate", "sand", "red_sand", "gravel", "netherrack", "soul_sand", "soul_soil"]);
const countItem = (inventory, name) => (inventory?.items || []).filter(item => item.name === name).reduce((sum, item) => sum + Number(item.count || 0), 0);

function defaultPlannerPath() {
  return process.env.TERRAIN_PLANNER_BIN || path.join(ROOT, "native", process.platform === "win32" ? "terrain_flatten.exe" : "terrain_flatten");
}

function runPlanner(binary, input, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true });
    let output = "";
    let error = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { error += chunk; });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve(output) : reject(new Error(error || `terrain planner exited with ${code}`)));
    child.stdin.end(input);
  });
}

function jsPlan(blocks, targetY, placeItem) {
  const dig = blocks.filter(block => block.y > targetY && block.diggable !== false && !EMPTY.has(block.name) && !PROTECTED.has(block.name)).sort((a, b) => b.y - a.y).map(block => ({ type: "dig", pos: block.pos }));
  const byPos = new Map(blocks.map(block => [`${block.x},${block.y},${block.z}`, block]));
  const place = blocks.filter(block => block.y === targetY && EMPTY.has(block.name) && !EMPTY.has(byPos.get(`${block.x},${targetY - 1},${block.z}`)?.name || "air")).map(block => ({ type: "place", item: placeItem, pos: block.pos }));
  return [...dig, ...place];
}

export class TerrainFlattenSkill {
  constructor({ api, worldModel, plannerPath = defaultPlannerPath(), logger = console } = {}) {
    this.api = api;
    this.worldModel = worldModel;
    this.plannerPath = plannerPath;
    this.logger = logger;
  }

  async #scan({ center, radius, targetY, scanBelow, scanAbove, onProgress }) {
    const positions = [];
    for (let x = center[0] - radius; x <= center[0] + radius; x += 1) for (let z = center[2] - radius; z <= center[2] + radius; z += 1) for (let y = targetY + scanAbove; y >= targetY - scanBelow; y -= 1) positions.push([x, y, z]);
    const blocks = [];
    for (let start = 0; start < positions.length; start += 32) {
      const batch = positions.slice(start, start + 32);
      const results = await Promise.all(batch.map(pos => this.api.getBlock({ pos })));
      results.forEach((response, index) => {
        const pos = batch[index];
        const block = response.result || {};
        blocks.push({ pos, x: pos[0], y: pos[1], z: pos[2], name: block.name || "air", diggable: block.diggable !== false });
      });
      onProgress({ mode: "scan", completed: Math.min(start + 32, positions.length), total: positions.length });
    }
    return blocks;
  }

  async run({ center, radius = 4, targetY, placeItem = "cobblestone", scanBelow = 4, scanAbove = 6, digTypes = null, maxOperations = 160, onProgress = () => {} } = {}) {
    const status = this.worldModel?.latest?.status || (await this.api.status()).result;
    const origin = center ? floorPos(center) : floorPos(status.pos);
    const y = Number.isFinite(Number(targetY)) ? Math.floor(Number(targetY)) : origin[1] - 1;
    const r = Math.min(8, Math.max(1, Number(radius) || 4));
    const item = String(placeItem || "cobblestone").replace(/^minecraft:/, "");
    const inventory = (await this.api.inventory()).result;
    if (!itemNames(inventory).has(item)) throw skillError(`缺少平整化所需方块：${item}`, "missing_item", { item });
    const available = countItem(inventory, item);
    const blocks = await this.#scan({ center: origin, radius: r, targetY: y, scanBelow: Math.min(8, Number(scanBelow) || 4), scanAbove: Math.min(8, Number(scanAbove) || 6), onProgress });
    const allowed = Array.isArray(digTypes) && digTypes.length ? new Set(digTypes.map(type => String(type).replace(/^minecraft:/, ""))) : DEFAULT_TERRAIN;
    const filtered = blocks.filter(block => !allowed || allowed.has(block.name) || block.y === y);
    let operations;
    try {
      const input = filtered.map(block => `${block.x} ${block.y} ${block.z} ${block.name.replace(/\s+/g, "_")} ${block.diggable ? 1 : 0}`).join("\n") + "\n";
      const output = await runPlanner(this.plannerPath, input, ["--target-y", String(y), "--place-item", item]);
      operations = output.split(/\r?\n/).filter(Boolean).map(line => {
        const [op, x, yy, z, name] = line.split(/\s+/);
        return op === "place" ? { type: op, item: name, pos: [Number(x), Number(yy), Number(z)] } : { type: op, pos: [Number(x), Number(yy), Number(z)] };
      });
    } catch (error) {
      this.logger.warn?.(`[terrain] C++ planner unavailable, using JS fallback: ${error.message}`);
      operations = jsPlan(filtered, y, item);
    }
    operations = operations.slice(0, Math.min(Number(maxOperations) || 160, 200));
    let placed = 0;
    let dug = 0;
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index];
      if (operation.type === "dig") {
        await this.api.dig({ pos: operation.pos, collect: true });
        dug += 1;
      } else {
        if (placed >= available) break;
        await this.api.place({ item, pos: operation.pos });
        placed += 1;
      }
      onProgress({ mode: "apply", completed: index + 1, total: operations.length, operation, dug, placed });
    }
    return { mode: "terrain_flatten", center: origin, targetY: y, radius: r, dug, placed, planner: this.plannerPath };
  }
}
