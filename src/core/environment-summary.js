const HOSTILE_TYPES = new Set(["hostile", "monster"]);
const round1 = value => typeof value === "number" && Number.isFinite(value) ? Math.round(value * 10) / 10 : value;
const pos1 = value => Array.isArray(value) ? value.map(round1) : value;

function itemList(inventory) {
  return (inventory?.items || []).map(item => ({
    name: item.name,
    count: item.count,
    slot: item.slot,
    durability: item.durability,
    enchantments: item.enchantments
  }));
}

function statusSummary(status = {}) {
  return {
    position: pos1(status.pos) || null,
    dimension: status.dimension || null,
    biome: status.biome || null,
    health: round1(status.health),
    food: round1(status.food),
    saturation: round1(status.saturation),
    armorPoints: round1(status.armor_points),
    xp: { level: status.xp_level, progress: round1(status.xp_progress) },
    oxygen: status.oxygen,
    held: status.held || null,
    offhand: status.offhand || null,
    effects: (status.effects || []).map(effect => ({ ...effect, duration_s: round1(effect.duration_s) })),
    hazards: {
      alive: status.alive,
      ready: status.ready,
      onFire: status.on_fire,
      inLava: status.in_lava,
      inWater: status.in_water,
      submerged: status.submerged,
      onGround: status.on_ground,
      busy: status.busy,
      vehicle: status.in_vehicle
    },
    time: { timeOfDay: status.time_of_day, day: status.is_day, raining: status.raining, thundering: status.thundering }
  };
}

function entitySummary(entities = []) {
  return entities.slice(0, 40).map(entity => ({
    id: entity.id,
    type: entity.type,
    name: entity.name,
    position: pos1(entity.pos),
    distance: round1(entity.dist),
    visible: entity.visible,
    lineOfSight: entity.line_of_sight ?? entity.has_line_of_sight,
    health: round1(entity.health),
    item: entity.item
  }));
}

function roundVisibleBlocks(value) {
  if (Array.isArray(value)) return value.map(roundVisibleBlocks);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (key === "pos" || key === "nearest") return [key, pos1(item)];
    if (["dist", "hardness"].includes(key)) return [key, round1(item)];
    return [key, roundVisibleBlocks(item)];
  }));
}

function riskSummary(snapshot) {
  const status = snapshot.status || {};
  const hostile = entitySummary(snapshot.entities).filter(entity => HOSTILE_TYPES.has(entity.type) || entity.type === "hostile");
  const risks = [];
  if (!status.alive) risks.push("dead");
  if (status.in_lava) risks.push("in_lava");
  if (status.on_fire) risks.push("on_fire");
  if (status.submerged && status.oxygen < 80) risks.push("low_oxygen");
  if (status.health !== undefined && status.health < 8) risks.push("critical_health");
  if (status.food !== undefined && status.food < 6) risks.push("low_food");
  if (hostile.some(entity => entity.distance !== undefined && entity.distance <= 4 && entity.visible !== false && entity.line_of_sight !== false)) risks.push("nearby_hostile");
  return { risks, nearbyHostiles: hostile.filter(entity => entity.distance === undefined || entity.distance <= 24).slice(0, 12) };
}

/**
 * Projects one coherent WorldModel snapshot into the fields each layer needs.
 * Keep this intentionally JSON-safe: the same object is shown in the UI and
 * sent to an LLM, so it must not contain API clients or runtime objects.
 */
export function summarizeEnvironment(snapshot = {}, layer = "strategy") {
  const base = {
    observedAt: snapshot.observedAt || null,
    status: statusSummary(snapshot.status),
    risks: riskSummary(snapshot),
    nearbyEntities: entitySummary(snapshot.entities),
    visibleBlocks: {
      ...(roundVisibleBlocks(snapshot.blocks) || {}),
      // Keep decision-critical facilities independent from the capped,
      // untyped block summary.
      facilities: roundVisibleBlocks(snapshot.facilities?.blocks || [])
    },
    spatial: snapshot.spatial || null,
    mission: snapshot.mission || null,
    recentEvents: (snapshot.events || []).slice(-20),
    inventory: {
      items: itemList(snapshot.inventory),
      armor: snapshot.inventory?.armor || null,
      offhand: snapshot.inventory?.offhand || null,
      held: snapshot.inventory?.held || null,
      emptySlots: snapshot.inventory?.empty_slots
    }
  };

  if (layer === "tac") {
    return {
      observedAt: base.observedAt,
      status: base.status,
      risks: base.risks,
      nearestHostile: snapshot.status?.nearest_hostile || null,
      nearbyHostiles: base.risks.nearbyHostiles,
      localSpace: base.spatial ? { origin: base.spatial.origin, ownColumn: base.spatial.ownColumn, columns: base.spatial.columns, hazards: base.spatial.hazards } : null,
      emergencyResources: itemList(snapshot.inventory).filter(item => ["shield", "water_bucket", "ender_pearl", "golden_apple", "golden_carrot", "cooked_beef", "cooked_porkchop", "cooked_mutton", "cooked_chicken", "bread", "baked_potato", "cobblestone", "cobbled_deepslate", "dirt"].includes(item.name))
    };
  }

  if (layer === "action") {
    return {
      observedAt: base.observedAt,
      status: base.status,
      risks: base.risks,
      nearbyEntities: base.nearbyEntities,
      visibleBlocks: base.visibleBlocks,
      spatial: base.spatial,
      inventory: base.inventory
    };
  }

  return {
    ...base,
    completedAdvancements: snapshot.advancements?.summary || snapshot.advancements?.advancements?.filter(item => item.status === "completed") || [],
    planningNotes: [
      "只使用公开接口观察；方块统计不能代替通路几何。",
      "移动前判断落脚空间和可退回路线；开挖位置由当前任务几何决定。",
      "方块未被探测到不代表地下没有；未知不能当空气。"
    ]
  };
}

export function formatEnvironmentPrompt(snapshot, layer = "strategy") {
  return JSON.stringify(summarizeEnvironment(snapshot, layer));
}
