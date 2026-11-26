import { passableCell, solidSupport } from "../core/spatial-observer.js";

/** Resolve a fuzzy destination from public block observations. Unknown cells
 * never count as empty. Exact construction targets opt out of substitution. */
export async function resolveStandDestination(api, params, current) {
  if (!api.getBlock || !Array.isArray(current) || !Number.isFinite(params.x) || !Number.isFinite(params.z)) return params;
  const x = Math.floor(params.x), z = Math.floor(params.z), y = Math.floor(params.y ?? current[1]);
  const cache = new Map();
  const at = p => {
    const k = p.join(",");
    if (!cache.has(k)) cache.set(k, api.getBlock({ pos: p }).then(r => r.result));
    return cache.get(k);
  };
  const valid = async p => {
    const [ground, feet, head] = await Promise.all([-1, 0, 1].map(dy => at([p[0], p[1] + dy, p[2]])));
    return solidSupport(ground) && passableCell(feet) && passableCell(head);
  };
  if (params.exact === true) {
    if (await valid([x, y, z])) return params;
    throw Object.assign(new Error("精确落脚点缺少支撑或两格净空"), { code: "unsafe_navigation", details: { target: [x, y, z] } });
  }
  const candidates = [];
  const ys = [...new Set([Math.floor(current[1]), Math.floor(current[1]) + 1, Math.floor(current[1]) - 1, y, y + 1, y - 1])];
  const radius = Math.min(2, Math.max(0, Math.floor(Number(params.range ?? 1))));
  for (const cy of ys) for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) {
    if (Math.hypot(dx, dz) > radius || Math.abs(cy - y) > 2) continue;
    candidates.push([x + dx, cy, z + dz]);
  }
  candidates.sort((a, b) => (Math.abs(a[1] - current[1]) * 4 + Math.hypot(a[0] - x, a[2] - z)) - (Math.abs(b[1] - current[1]) * 4 + Math.hypot(b[0] - x, b[2] - z)));
  for (const p of candidates) if (await valid(p)) return { ...params, x: p[0] + 0.5, y: p[1], z: p[2] + 0.5, range: 0.3 };
  throw Object.assign(new Error("目标附近没有已确认支撑和两格净空的等价落脚点"), { code: "unsafe_navigation", details: { requested: [x, y, z], current } });
}
