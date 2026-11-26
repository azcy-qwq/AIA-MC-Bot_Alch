const MAX_COMBAT_DISTANCE = 4;
const MAX_VERTICAL_OFFSET = 2.25;
const NEUTRAL = new Set(["enderman", "zombified_piglin", "piglin", "wolf", "bee", "polar_bear", "iron_golem", "llama", "trader_llama"]);
const RANGED = new Set(["skeleton", "stray", "bogged", "pillager", "illusioner", "witch", "blaze", "ghast"]);

export function isRangedCombatant(entity) {
  return RANGED.has(String(entity?.name || "").replace(/^minecraft:/, ""));
}

/**
 * The entity API reports a straight-line distance, but an entity above or
 * behind blocks can still be unreachable. Keep ordinary combat conservative:
 * only a very close target with a plausible vertical alignment is considered
 * a direct threat. Tac may still react to hurt/death events independently.
 */
export function isDirectCombatThreat(status = {}, entity = null, { maxDistance = MAX_COMBAT_DISTANCE } = {}) {
  if (!entity) return false;
  const name = String(entity.name || "").replace(/^minecraft:/, "");
  const neutral = NEUTRAL.has(name) || (name === "spider" && status.is_day === true);
  if (neutral && entity.aggressive !== true && entity.angry !== true && entity.confirmed_attacker !== true) return false;
  const distance = Number(entity.dist ?? entity.distance);
  if (!Number.isFinite(distance) || distance > maxDistance) return false;
  if (entity.visible === false || entity.line_of_sight === false || entity.has_line_of_sight === false) return false;
  const botPos = status.pos;
  const entityPos = entity.pos || entity.position;
  if (Array.isArray(botPos) && Array.isArray(entityPos) && botPos.length >= 3 && entityPos.length >= 3) {
    if (Math.abs(Number(entityPos[1]) - Number(botPos[1])) > MAX_VERTICAL_OFFSET) return false;
  }
  return true;
}

export { MAX_COMBAT_DISTANCE, MAX_VERTICAL_OFFSET };
