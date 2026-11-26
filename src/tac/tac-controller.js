import { EventBus } from "../core/events.js";
import { summarizeEnvironment } from "../core/environment-summary.js";
import { isDirectCombatThreat } from "./combat-target.js";
import { PveCombatScript } from "../skills/pve-combat.js";
import { TacticalSurvivalScript } from "../skills/tactical-survival.js";

const RESPONSES = new Set(["shield", "flee", "barricade", "shelter", "eat", "attack"]);
export function normalizeTactics(value = {}) {
  const raw = Array.isArray(value?.responses) ? value.responses : String(value?.responses || "").split(/[\s,，、|/]+/);
  return { urgent: value?.urgent === true, reason: String(value?.reason || ""), responses: [...new Set(raw.filter(r => RESPONSES.has(r)))].slice(0, 3) };
}
export class TacController {
  constructor({ api, worldModel, executor, eventBus = new EventBus(), intervalMs = 250, cooldownMs = 1500, provider = null, pve = null }) {
    Object.assign(this, { api, worldModel, executor, events: eventBus, intervalMs, cooldownMs, provider });
    this.pve = pve || new PveCombatScript({ api, worldModel, executor });
    this.survival = new TacticalSurvivalScript({ api, worldModel, executor });
    this.timer = null; this.engaged = false; this.stopped = false;
    this.decision = null; this.lastReviewAt = 0; this.lastReviewFingerprint = null;
    this.lastEmergencyAt = new Map();
    this.recentAttackers = new Map();
    this.offEvent = worldModel.events.on("game-event", event => this.#onGameEvent(event).catch(error => this.#error(error)));
    this.offRespawn = eventBus.on("respawned", () => {
      this.lastEmergencyAt.clear(); this.lastReviewAt = 0; this.lastReviewFingerprint = null;
      this.pve.skippedUntil?.clear();
      this.recentAttackers.clear();
      this.events.emit("tac-reset", { reason: "respawned" });
    });
  }
  #error(error) {
    if (!["dead", "cancelled", "interrupted", "busy"].includes(error?.code)) this.events.emit("runtime-warning", { type: "tac", error: { message: error.message, code: error.code } });
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => this.tick().catch(error => this.#error(error)), this.intervalMs);
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer); this.timer = null;
    this.offEvent?.(); this.offRespawn?.();
  }
  async tick() {
    if (this.stopped || this.engaged) return;
    const snapshot = this.worldModel.latest, status = snapshot.status;
    if (!status?.ready || !status.alive) return;
    const candidates = (snapshot.entities || []).map(e => (this.recentAttackers.get(e.id) || 0) > Date.now() ? { ...e, confirmed_attacker: true } : e);
    const hostile = candidates.find(e => ["hostile", "monster"].includes(e.type) && isDirectCombatThreat(status, e) && (this.pve.skippedUntil?.get(e.id) || 0) <= Date.now())
      || (isDirectCombatThreat(status, status.nearest_hostile) && (this.pve.skippedUntil?.get(status.nearest_hostile.id) || 0) <= Date.now() ? status.nearest_hostile : null);
    const hazard = status.in_lava ? "lava" : status.on_fire ? "fire" : status.submerged && status.oxygen < 80 ? "drowning" : null;
    if (hazard || hostile) return this.#emergency(hazard || "combat", hostile, null);
    if (status.blocking) await this.survival.run({ type: "posture", params: { shield: false } });
    this.#review(snapshot).catch(error => this.#error(error));
  }
  async #review(snapshot) {
    if (!this.provider?.createTactics || this.decision || this.engaged || this.stopped) return;
    const s = snapshot.status || {};
    const nearby = (snapshot.entities || []).filter(e => ["hostile", "monster"].includes(e.type) && Number(e.dist) <= 12);
    if (!(s.health < 14 || s.submerged || s.on_fire || nearby.length || (s.on_ground === false && !s.in_water))) return;
    const fingerprint = JSON.stringify([Math.floor(s.health), Math.floor((s.oxygen ?? 400) / 40), s.on_ground, s.submerged, nearby.map(e => [e.id, Math.floor(e.dist / 2)])]);
    if (Date.now() - this.lastReviewAt < (fingerprint === this.lastReviewFingerprint ? 30000 : 8000)) return;
    this.lastReviewAt = Date.now(); this.lastReviewFingerprint = fingerprint;
    const position = s.pos?.slice(), health = s.health;
    const context = summarizeEnvironment(snapshot, "tac");
    this.events.emit("tac-review-start", { context });
    const pending = this.provider.createTactics({ context, combat: false });
    this.decision = pending;
    try {
      const decision = normalizeTactics(await pending);
      this.events.emit("tac-decision", { decision, context });
      const current = this.worldModel.latest.status;
      if (this.stopped || this.engaged || !current?.alive || !current.ready) return;
      if (position && current.pos && Math.hypot(...current.pos.map((n, i) => n - position[i])) > 4) return;
      if (current.health > health + 2) return;
      if (decision?.urgent) await this.#emergency("llm-risk", null, decision);
    } catch (error) { this.events.emit("tac-review-error", { error: { message: error.message } }); }
    finally { if (this.decision === pending) this.decision = null; }
  }
  async #onGameEvent(event) {
    if (event.type === "death") { this.events.emit("death", event); return; }
    if (event.type === "hurt" && !this.engaged && !this.stopped) {
      const s = this.worldModel.latest;
      if (!s.status?.alive || !s.status?.ready) return;
      const id = event.likely_attacker?.id || event.likely_attacker?.entity_id || event.likely_attacker;
      const observed = (s.entities || []).find(e => e.id === id);
      if (observed) this.recentAttackers.set(observed.id, Date.now() + 15000);
      const attacker = observed && isDirectCombatThreat(s.status, { ...observed, confirmed_attacker: true }) ? { ...observed, confirmed_attacker: true } : null;
      await this.#emergency("hurt", attacker || null, null);
    }
  }
  async #emergency(kind, hostile, decision) {
    if (this.engaged || this.stopped || Date.now() - (this.lastEmergencyAt.get(kind) || 0) < this.cooldownMs) return;
    this.lastEmergencyAt.set(kind, Date.now()); this.engaged = true;
    this.events.emit("emergency", { kind, actions: [{ type: "pve_first_strike" }], context: summarizeEnvironment(this.worldModel.latest, "tac") });
    try {
      this.executor.cancelPending("Tac emergency priority");
      if (this.executor.busy) try { await Promise.race([this.executor.stop(), new Promise(resolve => setTimeout(resolve, 750))]); } catch {}
      if (this.stopped || !this.worldModel.latest.status?.alive) return;
      // No model, equipment or shield request precedes the attack script.
      const strike = await this.pve.firstStrike({ target: hostile, timeoutMs: 1000 });
      if (strike.skipped && hostile) { this.events.emit("combat-skip", { kind, reason: strike.reason }); return; }
      const status = (await this.api.status()).result;
      if (!status?.alive || !status.ready || this.stopped) return;
      const responses = kind === "combat" || kind === "hurt"
        ? status.health < 10 || hostile?.name === "creeper" ? ["shield", "flee", "eat"] : strike.killed ? [] : ["shield"]
        : ["flee", "eat"];
      if (kind === "lava" || kind === "fire") {
        const inventory = (await this.api.inventory()).result;
        if (status.dimension === "overworld" && inventory?.items?.some(i => i.name === "water_bucket") && Array.isArray(status.pos)) {
          const pos = status.pos.map(Math.floor); pos[1]--;
          const block = await this.survival.block(pos);
          if (block?.name && !/^(?:air|cave_air|lava|water|flowing_lava|flowing_water)$/.test(block.name)) await this.survival.run({ type: "interact", params: { pos, item: "water_bucket" } });
        }
      }
      // Execute baseline survival immediately; the optional model never holds it up.
      const thinking = !decision && hostile && this.provider?.createTactics
        ? this.provider.createTactics({ context: summarizeEnvironment(this.worldModel.latest, "tac"), combat: true }).catch(() => null)
        : Promise.resolve(decision);
      await this.survival.respond({ responses, hostile });
      const advice = await thinking;
      decision = advice ? normalizeTactics(advice) : null;
      if (decision) this.events.emit("tac-decision", { decision });
      if (this.stopped || !this.worldModel.latest.status?.alive) return;
      const extra = Array.isArray(decision?.responses) ? decision.responses.filter(r => RESPONSES.has(r) && !responses.includes(r)) : [];
      await this.survival.respond({ responses: extra, hostile });
      if (extra.includes("attack") && hostile && (await this.api.status()).result?.health >= 10) await this.pve.firstStrike({ target: hostile });
    } finally {
      this.engaged = false;
      this.events.emit("tac-idle", { kind });
    }
  }
}
