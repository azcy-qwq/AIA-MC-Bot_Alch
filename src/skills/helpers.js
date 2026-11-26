export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function floorPos(pos) {
  return [Math.floor(pos[0]), Math.floor(pos[1]), Math.floor(pos[2])];
}

export function addPos(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function itemNames(inventory) {
  return new Set((inventory?.items || []).map(item => item.name));
}

export function chooseFirstItem(inventory, names) {
  const available = itemNames(inventory);
  return names.find(name => available.has(name)) || null;
}

export function skillError(message, code = "skill_failed", details = {}) {
  return Object.assign(new Error(message), { code, details });
}
