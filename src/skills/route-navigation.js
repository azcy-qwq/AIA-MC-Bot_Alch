import { floorPos, skillError } from "./helpers.js";
import { resolveStandDestination } from "../navigation/safe-destination.js";

export class RouteNavigationSkill {
  constructor({ api, worldModel, routeMemory }) {
    this.api = api;
    this.worldModel = worldModel;
    this.routeMemory = routeMemory;
  }

  async navigate({ from, to, waypoints = [], range = 1, onProgress = () => {}, signal } = {}) {
    if (!from || !to) throw skillError("route_navigate 需要 from 和 to 锚点", "bad_args");
    const target = this.routeMemory.resolve(to);
    if (!target) throw skillError(`未知目标锚点：${to}`, "unknown_anchor");
    const cached = this.routeMemory.getRoute(String(from), String(to));
    if (cached && await this.routeMemory.validate(this.api, cached)) {
      cached.useCount = (cached.useCount || 0) + 1;
      let index = 0;
      for (const pos of cached.waypoints) {
        await this.move(pos, range, signal);
        index += 1;
        onProgress({ mode: "cached_route", completed: index, total: cached.waypoints.length, pos });
      }
      await this.routeMemory.save();
      return { cached: true, from, to, waypoints: cached.waypoints, useCount: cached.useCount };
    }
    if (cached) await this.routeMemory.invalidate(String(from), String(to));
    const points = waypoints.length
      ? await this.routeMemory.normalizeWaypoints(this.api, waypoints, { target, minDistance: 5, searchRadius: 4 })
      : [target];
    if (!points.length) throw skillError("没有找到合法的路线途经点", "no_legal_waypoint");
    let index = 0;
    for (const pos of points) {
      await this.move(pos, range, signal);
      index += 1;
      onProgress({ mode: "record_route", completed: index, total: points.length, pos });
    }
    await this.routeMemory.record({ from: String(from), to: String(to), waypoints: points });
    return { cached: false, recorded: true, from, to, waypoints: points };
  }
  async move(pos, range, signal) {
    if (signal?.aborted) throw skillError("路线已取消", "cancelled");
    let params = { x: pos[0] + 0.5, y: pos[1], z: pos[2] + 0.5, range };
    if (this.api.status) params = await resolveStandDestination(this.api, params, (await this.api.status()).result?.pos);
    if (signal?.aborted) throw skillError("路线已取消", "cancelled");
    const result = await this.api.moveTo(params);
    const actual = result?.result?.pos;
    if (actual && (Math.hypot(actual[0] - params.x, actual[2] - params.z) > range + 0.75 || Math.abs(actual[1] - params.y) > 0.6)) throw skillError("路线移动实际未到达", "navigation_failed", { params, actual });
    return result;
  }
}
