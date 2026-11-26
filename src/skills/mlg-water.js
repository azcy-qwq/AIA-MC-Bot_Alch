import { floorPos, itemNames, skillError } from "./helpers.js";

/**
 * Best-effort water landing controller. There is no tick-level jump/aim API,
 * so it watches vertical movement and right-clicks the block below the bot.
 */
export class MlgWaterScript {
  constructor({ api, worldModel, executor, pollMs = 125, triggerDrop = 2.5, cooldownMs = 1500, logger = console }) {
    this.api = api;
    this.worldModel = worldModel;
    this.executor = executor;
    this.pollMs = pollMs;
    this.triggerDrop = triggerDrop;
    this.cooldownMs = cooldownMs;
    this.logger = logger;
    this.timer = null;
    this.previous = null;
    this.lastAttempt = 0;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(error => this.logger.warn?.("MLG monitor", error.message)), this.pollMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.previous = null;
  }

  async tick() {
    const response = await this.api.status();
    const status = response.result;
    if (!status?.alive || status.on_ground || !status.pos) {
      this.previous = status;
      return;
    }
    const previousY = this.previous?.pos?.[1];
    const falling = Number.isFinite(previousY) && previousY - status.pos[1] >= this.triggerDrop;
    this.previous = status;
    if (falling) await this.attempt(status);
  }

  async attempt(status = this.worldModel.latest.status) {
    if (!status?.pos || Date.now() - this.lastAttempt < this.cooldownMs) return { attempted: false, reason: "cooldown" };
    const inventory = this.worldModel.latest.inventory;
    if (!itemNames(inventory).has("water_bucket")) throw skillError("No water bucket available", "missing_item");
    this.lastAttempt = Date.now();
    const [x, y, z] = floorPos(status.pos);
    // The API documents interact-with-item for block use; the block below is
    // the safest target available without a ray/rotation endpoint.
    const result = await this.executor.enqueue({
      type: "interact",
      params: { pos: [x, y - 1, z], item: "water_bucket" }
    }, { source: "skill:mlg-water", priority: 100, attempts: 1 });
    return { attempted: true, result };
  }
}
