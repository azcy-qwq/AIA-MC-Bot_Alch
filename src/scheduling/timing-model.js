import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const finite = value => typeof value === "number" && Number.isFinite(value);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const quantile = (values, p) => {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p, lo = Math.floor(i);
  return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo);
};
const COST_MS = { chop_tree: 2500, mine_vein: 3500, fishbone_mine: 6000, staircase_up: 9000, staircase_down: 7500, move_to: 700, route_navigate: 700, navigation_recover: 700, bridge_to: 3000, pillar: 2500, build_workarea: 6000, build_base: 9000, craft: 4000, workshop: 5000, equip: 500, mark_anchor: 80, inspect_state: 80 };
const EXCAVATION = new Set(["chop_tree", "mine_vein", "fishbone_mine", "staircase_up", "staircase_down", "build_workarea", "build_base"]);
const distance = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === 3 && b.length === 3 ? Math.hypot(...a.map((n, i) => n - b[i])) : null;

export function timingProfile(action, snapshot = {}) {
  const type = action.type;
  let tool = "none";
  if (EXCAVATION.has(type)) {
    const suffix = type === "chop_tree" ? "_axe" : "_pickaxe";
    const items = [...(snapshot.inventory?.items || []), snapshot.status?.held].filter(Boolean);
    tool = ["netherite", "diamond", "iron", "stone", "wooden", "golden"].find(tier => items.some(item => item.name === tier + suffix)) || "none";
  }
  const mode = type === "workshop" ? String(action.params?.mode || "craft") : "";
  return `${type}|${tool}|${snapshot.status?.dimension || "overworld"}|${mode}`;
}

// Units are work, never a block count mistaken for traversable geometry.
export function plannedWork(action, snapshot = {}, nativeState = {}) {
  nativeState ||= {};
  const p = action.params || {}, type = action.type;
  if (["chop_tree", "mine_vein"].includes(type)) {
    const drops = new Set((p.types || ["iron_ore", "deepslate_iron_ore"]).map(n => n.replace(/^deepslate_/, "").replace(/^(iron|gold|copper)_ore$/, "raw_$1").replace(/_ore$/, "")));
    const stock = (snapshot.inventory?.items || []).reduce((n, item) => n + ((type === "chop_tree" ? /_(log|wood)$/.test(item.name) : drops.has(item.name)) ? item.count || 0 : 0), 0);
    return Math.max(0, (p.targetCount || (type === "chop_tree" ? 32 : 16)) - stock);
  }
  if (type === "fishbone_mine") {
    const lane = nativeState.fishboneRoutes?.[`fishbone:${p.laneId || p.anchor || "1"}`];
    const length = lane?.length ?? p.length ?? 512, branch = lane?.branchLength ?? p.branchLength ?? 8, every = lane?.branchEvery ?? p.branchEvery ?? 3;
    const total = length + 2 * Math.floor(length / every) * branch;
    const completed = (lane?.mainStep || 0) + (lane?.branches || []).reduce((n, b) => n + (distance(b.hub, b.end) || 0), 0);
    return Math.max(0, total - completed);
  }
  if (/^staircase_/.test(type)) return p.steps ?? 8;
  if (type === "pillar") return p.height ?? 1;
  if (type === "build_workarea") return 25;
  if (type === "build_base") { const width = Number(p.width) || 5, depth = Number(p.depth) || 5, height = Number(p.wallHeight) || 3; return width * depth + (2 * (width + depth) - 4) * height + width * depth; }
  if (["move_to", "route_navigate", "bridge_to", "navigation_recover"].includes(type)) {
    const target = p.target || p.pos || nativeState.anchors?.[p.to]?.pos;
    return distance(snapshot.status?.pos, target);
  }
  if (type === "workshop" && p.mode === "smelt") return p.count ?? 1;
  if (["craft", "workshop"].includes(type)) return p.items?.length || 1;
  return ["equip", "mark_anchor", "inspect_state"].includes(type) ? 1 : null;
}

export class TimingModel {
  constructor({ filePath = "data/task-timing-model.json", journalPath = "data/task-timing-samples.jsonl", now = Date.now, onError = () => {} } = {}) {
    Object.assign(this, { filePath, journalPath, now, onError });
    this.data = { version: 1, profiles: {}, distribution: {}, counts: { actions: 0, failures: 0, distribution: 0 } };
    this.saving = Promise.resolve(); this.lastSavedAt = 0;
  }
  async load() {
    if (!this.filePath) return;
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8"));
      if (value.version !== 1 || !value.profiles || !value.distribution || !value.counts) throw new Error("耗时数据格式不兼容，重新采样");
      this.data = value;
    } catch (error) { if (error.code !== "ENOENT") this.onError(error); }
  }
  journal(event) {
    if (!this.journalPath) return;
    const line = JSON.stringify({ at: this.now(), ...event }) + "\n";
    this.saving = this.saving.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.journalPath), { recursive: true });
      if ((await stat(this.journalPath).catch(() => ({ size: 0 }))).size > 5_000_000) await rename(this.journalPath, `${this.journalPath}.previous`);
      await appendFile(this.journalPath, line);
    }).catch(this.onError);
  }
  persist(force = false) {
    if (!this.filePath || (!force && this.now() - this.lastSavedAt < 10000)) return this.saving;
    this.lastSavedAt = this.now(); this.data.updatedAt = this.now();
    const payload = JSON.stringify(this.data);
    this.saving = this.saving.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(`${this.filePath}.tmp`, payload);
      await rename(`${this.filePath}.tmp`, this.filePath);
    }).catch(this.onError);
    return this.saving;
  }
  observeRate(key, durationMs, units) {
    if (!(durationMs > 0 && units > 0)) return;
    const profile = this.data.profiles[key] ||= { samples: [], rates: [] };
    profile.rates.push(durationMs / units);
    profile.rates = profile.rates.slice(-80);
    this.persist();
  }
  observeAction({ key, units, durationMs, success, errorCode, runId }) {
    this.data.counts.actions++; if (!success) this.data.counts.failures++;
    if (success && units > 0 && durationMs > 0) {
      const profile = this.data.profiles[key] ||= { samples: [], rates: [] };
      profile.samples.push({ units, durationMs, at: this.now() }); profile.samples = profile.samples.slice(-80);
    }
    this.journal({ kind: "action-finish", key, runId, units, durationMs, success, errorCode }); this.persist(true);
  }
  observeDistribution({ model = "default", durationMs, success, inputChars, errorCode }) {
    if (!finite(durationMs) || durationMs < 0) return;
    const samples = this.data.distribution[model] ||= [];
    samples.push({ durationMs, success, inputChars, at: this.now() }); this.data.distribution[model] = samples.slice(-80);
    this.data.counts.distribution++;
    this.journal({ kind: "distribution", model, durationMs, success, inputChars, errorCode }); this.persist(true);
  }
  distributionEstimate(model = "default") {
    const all = this.data.distribution[model] || [], samples = all.filter(s => s.success).map(s => s.durationMs);
    if (!samples.length) return { expectedMs: 20000, p90Ms: 30000, leadMs: 32000, samples: 0, source: "bootstrap" };
    const expectedMs = samples.reduce((sum, n, i) => sum + n * Math.pow(0.92, samples.length - 1 - i), 0) / samples.reduce((sum, _, i) => sum + Math.pow(0.92, samples.length - 1 - i), 0);
    // Slow failures still warn the scheduler about congestion without teaching
    // it that failed requests produce usable plans.
    const recentSlow = all.slice(-8).filter(s => !s.success).map(s => s.durationMs);
    const p90Ms = Math.max(expectedMs, quantile(samples.slice(-40), 0.9), ...recentSlow, 1000);
    return { expectedMs, p90Ms, leadMs: p90Ms + 2000, samples: samples.length, source: "measured" };
  }
  predict(key, units) {
    if (!finite(units) || units < 0) return null;
    const type = key.split("|")[0], exact = this.data.profiles[key];
    const profiles = exact?.samples?.length || exact?.rates?.length ? [exact] : Object.entries(this.data.profiles).filter(([k]) => k.startsWith(`${type}|`)).map(([, v]) => v);
    const samples = profiles.flatMap(p => p.samples || []).slice(-80), rates = profiles.flatMap(p => p.rates || []).slice(-80);
    let perUnitMs = quantile(rates, 0.5) ?? quantile(samples.map(s => s.durationMs / s.units), 0.5) ?? COST_MS[type];
    if (!finite(perUnitMs)) return null;
    let overheadMs = 0, source = samples.length || rates.length ? "history-rate" : "bootstrap";
    // Recency weighted least squares: T = startup + cost * work. A fit needs
    // several successful runs with genuinely different work sizes.
    if (samples.length >= 5) {
      let w = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
      samples.forEach((s, i) => { const a = Math.pow(0.95, samples.length - 1 - i); w += a; sx += a * s.units; sy += a * s.durationMs; sxx += a * s.units ** 2; sxy += a * s.units * s.durationMs; });
      const variance = sxx - sx * sx / w;
      if (variance > Math.max(0.1, sx * sx / w * 0.01)) {
        const slope = (sxy - sx * sy / w) / variance, intercept = (sy - slope * sx) / w;
        if (slope > 0 && intercept >= 0) { perUnitMs = slope; overheadMs = intercept; source = "weighted-linear"; }
      }
    }
    if (type === "workshop" && key.endsWith("|smelt") && source === "bootstrap") perUnitMs = 10000;
    const expectedMs = overheadMs + perUnitMs * units;
    const deviation = quantile(rates.map(rate => Math.abs(rate - perUnitMs) / Math.max(perUnitMs, 1)), 0.8) ?? 0.25;
    return { expectedMs, perUnitMs, overheadMs, lowerMs: expectedMs * (1 - clamp(deviation, 0.1, 0.5)), samples: samples.length, rateSamples: rates.length, source };
  }
  async flush() { await this.persist(true); await this.saving; }
}
