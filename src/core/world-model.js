import { EventBus, EventCursor } from "./events.js";
import { SpatialObserver } from "./spatial-observer.js";

/**
 * Central observation cache. Strategy reads a coherent snapshot; Tac can use
 * the latest status without waiting for the slow planning cycle.
 */
export class WorldModel {
  constructor(api, { observationIntervalMs = 1000, inventoryIntervalMs = 2000, entitiesIntervalMs = 500, blocksIntervalMs = 2000, facilitiesIntervalMs = 5000, advancementsIntervalMs = 15000 } = {}) {
    this.api = api;
    this.observationIntervalMs = observationIntervalMs;
    this.intervals = { inventory: inventoryIntervalMs, entities: entitiesIntervalMs, blocks: blocksIntervalMs, facilities: facilitiesIntervalMs, advancements: advancementsIntervalMs };
    this.events = new EventBus();
    this.cursor = new EventCursor();
    this.snapshot = { status: null, inventory: null, entities: [], blocks: null, facilities: null, events: [], observedAt: 0 };
    this.timer = null;
    this.refreshing = null;
    this.lastObservedAt = { inventory: 0, entities: 0, blocks: 0, advancements: 0 };
    this.pending = new Map();
    this.responses = new Map();
    this.spatial = new SpatialObserver(api);
  }

  get latest() { return this.snapshot; }

  async #read(name, fn, { force = false } = {}) {
    const now = Date.now();
    const due = force || !this.lastObservedAt[name] || now - this.lastObservedAt[name] >= this.intervals[name];
    if (!due && this.responses.has(name)) return this.responses.get(name);
    if (this.pending.has(name)) return this.pending.get(name);
    const request = Promise.resolve().then(fn).then(result => {
      this.lastObservedAt[name] = Date.now();
      this.responses.set(name, result);
      this.pending.delete(name);
      return result;
    }, error => { this.pending.delete(name); throw error; });
    this.pending.set(name, request);
    return request;
  }

  async refresh({ force = false } = {}) {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const [status, inventory, entities, blocks, facilities, eventResult, advancements] = await Promise.all([
        this.api.status(),
        this.#read("inventory", () => this.api.inventory(), { force }),
        this.#read("entities", () => this.api.getEntities({ radius: 24 }), { force }),
        // Include nearby public facilities in the shared observation. A 16
        // block scan often misses a table just beyond a shoreline exit.
        this.#read("blocks", () => this.api.findBlocks({ radius: 32 }), { force }),
        // Facility lookup is deliberately separate from the terrain summary:
        // the public endpoint truncates the untyped result by block class, so
        // a nearby table can disappear behind trees, ores, or terrain noise.
        this.#read("facilities", () => this.api.findBlocks({ types: ["enchanting_table", "bookshelf", "crafting_table", "furnace", "chest"], radius: 64, limit: 64 }), { force }),
        this.api.events({ since: this.cursor.lastSeq, limit: 100 }),
        (this.api.advancements ? this.#read("advancements", () => this.api.advancements({ status: "completed", include_recipes: false }), { force }).catch(() => ({ result: this.snapshot.advancements })) : Promise.resolve({ result: null }))
      ]);
      const events = this.cursor.accept(eventResult.result);
      this.snapshot = {
        status: status.result,
        inventory: inventory.result,
        entities: entities.result?.entities || [],
        blocks: blocks.result,
        facilities: facilities.result,
        events,
        advancements: advancements.result,
        spatial: this.spatial.current(status.result),
        observedAt: Date.now()
      };
      for (const event of events) this.events.emit("game-event", event);
      this.events.emit("snapshot", this.snapshot);
      this.refreshSpatial().catch(error => this.events.emit("error", error));
      return this.snapshot;
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async refreshSpatial() {
    await this.spatial.observe(this.snapshot.status);
    this.snapshot.spatial = this.spatial.current(this.snapshot.status);
    return this.snapshot.spatial;
  }

  invalidateSpatial() { this.spatial.invalidate(); this.snapshot.spatial = null; }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.refresh().catch(error => this.events.emit("error", error)), this.observationIntervalMs);
    this.refresh().catch(error => this.events.emit("error", error));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
