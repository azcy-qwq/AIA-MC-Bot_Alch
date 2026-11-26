import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const UNSAFE = new Set(["lava", "flowing_lava", "water", "flowing_water", "bubble_column", "void_air"]);
const EMPTY = new Set(["air", "cave_air", "void_air"]);
const distanceXZ = (a, b) => Math.hypot(Number(a[0]) - Number(b[0]), Number(a[2]) - Number(b[2]));
const floorPos = pos => [Math.floor(Number(pos[0])), Math.floor(Number(pos[1])), Math.floor(Number(pos[2]))];

export class RouteMemory {
  constructor({ filePath = null } = {}) {
    this.filePath = filePath;
    this.anchors = new Map();
    this.routes = new Map();
  }

  async load() {
    if (!this.filePath) return this;
    try {
      const data = JSON.parse(await readFile(this.filePath, "utf8"));
      for (const [name, pos] of Object.entries(data.anchors || {})) this.anchors.set(name, pos);
      for (const [key, route] of Object.entries(data.routes || {})) this.routes.set(key, route);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return this;
  }

  async save() {
    if (!this.filePath) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.snapshot(), null, 2), "utf8");
  }

  setAnchor(name, pos) {
    if (!name || !Array.isArray(pos) || pos.length !== 3) throw new Error("Anchor requires a name and [x,y,z] position");
    this.anchors.set(String(name), pos.map(Number));
    return this.anchors.get(String(name));
  }

  resolve(value) {
    if (Array.isArray(value)) return value.map(Number);
    return this.anchors.get(String(value)) || null;
  }

  key(from, to) { return `${from}=>${to}`; }

  getRoute(from, to) { return this.routes.get(this.key(from, to)) || null; }

  async record({ from, to, waypoints }) {
    const route = { from, to, waypoints: waypoints.map(pos => pos.map(Number)), recordedAt: Date.now(), useCount: 0 };
    this.routes.set(this.key(from, to), route);
    await this.save();
    return route;
  }

  async invalidate(from, to) {
    this.routes.delete(this.key(from, to));
    await this.save();
  }

  async validate(api, route) {
    for (const pos of route.waypoints || []) {
      const [x, y, z] = pos;
      const support = (await api.getBlock({ pos: [x, y - 1, z] })).result;
      const feet = (await api.getBlock({ pos: [x, y, z] })).result;
      const head = (await api.getBlock({ pos: [x, y + 1, z] })).result;
      if (!this.isLegalPoint({ support, feet, head })) return false;
    }
    return true;
  }

  isLegalPoint({ support, feet, head } = {}) {
    return Boolean(support && feet && head
      && !UNSAFE.has(support.name) && !UNSAFE.has(feet.name) && !UNSAFE.has(head.name)
      && !EMPTY.has(support.name) && EMPTY.has(feet.name) && EMPTY.has(head.name));
  }

  async isLegal(api, pos) {
    const point = floorPos(pos);
    const [x, y, z] = point;
    const [support, feet, head] = await Promise.all([
      api.getBlock({ pos: [x, y - 1, z] }),
      api.getBlock({ pos: [x, y, z] }),
      api.getBlock({ pos: [x, y + 1, z] })
    ]);
    return this.isLegalPoint({ support: support.result, feet: feet.result, head: head.result });
  }

  /**
   * Keep an already legal point. Otherwise find the nearest legal point in a
   * small horizontal ring while preserving its approximate height.
   */
  async nearestLegal(api, desired, { searchRadius = 4 } = {}) {
    const origin = floorPos(Array.isArray(desired) ? desired : desired?.pos || [desired?.x, desired?.y, desired?.z]);
    if (!origin.every(Number.isFinite)) throw new Error("Waypoint requires [x,y,z]");
    if (await this.isLegal(api, origin)) return origin;
    const candidates = [];
    for (let radius = 1; radius <= Math.max(1, Number(searchRadius) || 4); radius += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
          for (const dy of [0, 1, -1, 2, -2]) candidates.push([origin[0] + dx, origin[1] + dy, origin[2] + dz]);
        }
      }
    }
    candidates.sort((a, b) => Math.abs(a[1] - origin[1]) - Math.abs(b[1] - origin[1]) || distanceXZ(a, origin) - distanceXZ(b, origin));
    for (const candidate of candidates) if (await this.isLegal(api, candidate)) return candidate;
    return null;
  }

  async normalizeWaypoints(api, waypoints, { minDistance = 5, searchRadius = 4, target = null } = {}) {
    const normalized = [];
    for (const raw of Array.isArray(waypoints) ? waypoints : []) {
      const desired = Array.isArray(raw) ? raw : raw?.pos || raw?.near || raw?.around || raw;
      const point = await this.nearestLegal(api, desired, { searchRadius });
      if (!point) continue;
      if (normalized.length && distanceXZ(normalized.at(-1), point) < minDistance) continue;
      normalized.push(point);
    }
    if (target) {
      const goal = floorPos(target);
      while (normalized.length && distanceXZ(normalized.at(-1), goal) > 0 && distanceXZ(normalized.at(-1), goal) < minDistance) normalized.pop();
      if (!normalized.length || distanceXZ(normalized.at(-1), goal) > 0) normalized.push(goal);
    }
    return normalized;
  }

  snapshot() {
    return { anchors: Object.fromEntries(this.anchors), routes: Object.fromEntries(this.routes) };
  }
}
