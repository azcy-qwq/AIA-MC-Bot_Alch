import { readFileSync } from "node:fs";
import { EARLY_SURVIVAL_FLOW } from "./early-survival-flow.js";

// A planning reference supplied by the user, not instructions for this host.
export const TACTICAL_REVISION = "survival-diamond-enchant-flow-v5";
export const TACTICAL_REFERENCE = readFileSync(new URL("../../docs/tactical-guide.txt", import.meta.url), "utf8");
export { EARLY_SURVIVAL_FLOW };
export const STRATEGIC_INTERVAL_MS = 240000;
