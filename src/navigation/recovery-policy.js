const PATH_ACTIONS = new Set(["move_to", "route_navigate"]);
const PATH_FAILURES = new Set(["path_not_found", "timeout", "unreachable", "no_path", "navigation_failed", "stalled"]);

export const RECOVERY_ACTIONS = new Set(["navigation_recover", "bridge_to", "ladder_climb", "staircase_down", "staircase_up"]);

// A network timeout, a crafting error or an old failure is not evidence that a path is blocked.
export function canRecoverNavigation(failure, now = Date.now()) {
  return Boolean(failure && PATH_ACTIONS.has(failure.action) && PATH_FAILURES.has(failure.code)
    && now - failure.at >= 0 && now - failure.at <= 120000);
}
