import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function targetOf(action = {}) {
  const params = action.params || {};
  if (params.target) return params.target;
  if (params.pos) return { pos: params.pos };
  if (params.entity_id !== undefined) return { entity_id: params.entity_id };
  if (params.block) return { block: params.block };
  return null;
}

function trimSections(sections = {}) {
  return Object.fromEntries(Object.entries(sections).map(([name, items]) => [name, (Array.isArray(items) ? items : []).slice(0, 40).map(item => ({ name: item.name, count: item.count, slot: item.slot, custom_name: item.custom_name }))]));
}

export class StrategyMemory {
  constructor({ filePath = null, maxFacts = 100 } = {}) {
    this.filePath = filePath;
    this.maxFacts = maxFacts;
    this.facts = [];
  }

  async load() {
    if (!this.filePath) return this;
    try {
      const data = JSON.parse(await readFile(this.filePath, "utf8"));
      this.facts = Array.isArray(data.facts) ? data.facts.slice(-this.maxFacts) : [];
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return this;
  }

  async save() {
    if (!this.filePath) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify({ facts: this.facts }, null, 2), "utf8");
  }

  async recordAction({ action, result, error } = {}) {
    const target = targetOf(action);
    const response = result?.result || result;
    if (!error && response?.warning) error = response;
    let fact = null;
    if (error) {
      fact = { type: "action_failure", key: `failure:${action?.type}:${JSON.stringify(target)}`, action: action?.type, target, code: error.code, message: error.message, at: Date.now() };
    } else if (action?.type === "window_view" || action?.type === "interact" && response?.window) {
      fact = { type: "window_observation", key: `window:${JSON.stringify(target)}`, action: action.type, target, window: response?.window, sections: trimSections(response?.sections), info: response?.info || null, at: Date.now() };
    } else if (action?.type === "window_act") {
      this.facts = this.facts.filter(item => !(item.type === "window_observation" && JSON.stringify(item.target) === JSON.stringify(target)));
      if (response?.sections) this.facts.push({ type: "window_observation", key: `window:${JSON.stringify(target)}`, target, window: response.window, sections: trimSections(response.sections), at: Date.now() });
      fact = { type: "window_action", key: `window_action:${JSON.stringify(target)}`, action: action.type, target, window: response?.window, sections: trimSections(response?.sections), at: Date.now() };
    }
    if (!fact) return;
    this.facts = this.facts.filter(item => item.key !== fact.key);
    this.facts.push(fact);
    if (this.facts.length > this.maxFacts) this.facts.splice(0, this.facts.length - this.maxFacts);
    await this.save();
  }

  snapshot() {
    return {
      facts: this.facts.slice(-40),
      notes: [
        "已记录的窗口观察可以直接复用；除非数据过期或任务需要确认，不要重复查看同一个箱子。",
        "window_view 只查看窗口；取放物品必须使用 window_act。"
      ]
    };
  }
}
