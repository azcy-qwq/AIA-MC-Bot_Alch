import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { EventBus } from "../core/events.js";

const trim = (value, max = 800) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function targetOf(action = {}) {
  const params = action.params || {};
  if (params.target) return params.target;
  if (params.pos) return { pos: params.pos };
  if (params.entity_id !== undefined) return { entity_id: params.entity_id };
  if (params.block) return { block: params.block };
  return null;
}

function keyPart(value) {
  return trim(typeof value === "string" ? value : JSON.stringify(value), 300).toLowerCase();
}

function factToEntry(fact = {}) {
  if (!fact.type) return null;
  if (fact.type === "action_failure") {
    return {
      kind: "failure",
      key: fact.key || `failure:${fact.action}:${keyPart(fact.target)}:${fact.code || "unknown"}`,
      summary: `动作 ${fact.action || "未知"} 失败：${fact.message || fact.code || "未知原因"}`,
      detail: { action: fact.action, target: fact.target, code: fact.code || null },
      importance: 0.95,
      tags: ["failure", fact.code || "unknown"],
      source: "action"
    };
  }
  if (fact.type === "window_observation") {
    const sections = fact.sections || {};
    const items = Object.values(sections).flat().filter(Boolean).slice(0, 20).map(item => `${item.name} x${item.count ?? 1}`);
    return {
      kind: "observation",
      key: fact.key || `window:${keyPart(fact.target)}`,
      summary: `已观察 ${fact.window || "容器"} 窗口${items.length ? `：${items.join("、")}` : "（没有可用物品）"}`,
      detail: { window: fact.window || null, target: fact.target || null, sections: fact.sections || {} },
      importance: 0.72,
      tags: ["window", fact.window || "container"],
      source: "action"
    };
  }
  if (fact.type === "window_action") {
    return {
      kind: "window_action",
      key: fact.key || `window-action:${keyPart(fact.target)}:${keyPart(fact.action)}`,
      summary: `已完成窗口操作：${fact.action || "window_act"}`,
      detail: { action: fact.action, target: fact.target || null, sections: fact.sections || {} },
      importance: 0.65,
      tags: ["window", "action"],
      source: "action"
    };
  }
  return null;
}

export class MemoryArchive {
  constructor({ filePath = null, maxEntries = 120, eventBus = new EventBus() } = {}) {
    this.filePath = filePath;
    this.maxEntries = maxEntries;
    this.events = eventBus;
    this.entries = [];
    this.latestSummary = null;
    this.saving = Promise.resolve();
  }

  async load() {
    if (!this.filePath) return this;
    try {
      const data = JSON.parse(await readFile(this.filePath, "utf8"));
      this.entries = Array.isArray(data.entries) ? data.entries.slice(-this.maxEntries) : [];
      this.latestSummary = data.latestSummary || null;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return this;
  }

  save() {
    if (!this.filePath) return Promise.resolve();
    const data = JSON.stringify({ version: 1, entries: this.entries, latestSummary: this.latestSummary }, null, 2);
    this.saving = this.saving.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(`${this.filePath}.tmp`, data, "utf8");
      await rename(`${this.filePath}.tmp`, this.filePath);
    });
    return this.saving;
  }

  async upsert(entry) {
    if (!entry?.key || !entry.summary) return null;
    const now = Date.now();
    const previous = this.entries.find(item => item.key === entry.key);
    const merged = {
      ...previous,
      ...entry,
      summary: trim(entry.summary),
      detail: entry.detail || previous?.detail || null,
      tags: [...new Set([...(previous?.tags || []), ...(entry.tags || [])])].slice(0, 8),
      firstSeenAt: previous?.firstSeenAt || entry.at || now,
      lastSeenAt: now,
      count: (previous?.count || 0) + 1
    };
    this.entries = this.entries.filter(item => item.key !== entry.key);
    this.entries.push(merged);
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
    await this.save();
    this.events.emit("memory-archive-output", { entry: merged, count: this.entries.length });
    return merged;
  }

  async recordFact(fact) {
    return this.upsert(factToEntry(fact));
  }

  async importFacts(facts = []) {
    for (const fact of facts) {
      const entry = factToEntry(fact);
      if (entry && !this.entries.some(item => item.key === entry.key)) await this.upsert(entry);
    }
    return this;
  }

  async recordAction({ action, result, error, task } = {}) {
    const target = targetOf(action);
    const response = result?.result || result;
    if (!error && response?.warning) error = response;
    if (error) {
      return this.recordFact({ type: "action_failure", action: action?.type, target, code: error.code, message: error.message, key: `failure:${action?.type}:${keyPart(target)}:${error.code || "unknown"}` });
    }
    if (action?.type === "window_view" || (action?.type === "interact" && response?.window)) {
      return this.recordFact({ type: "window_observation", key: `window:${keyPart(target)}`, action: action.type, target, window: response?.window, sections: response?.sections || {}, at: Date.now() });
    }
    if (action?.type === "window_act") {
      this.entries = this.entries.filter(item => !(item.kind === "observation" && keyPart(item.detail?.target) === keyPart(target)));
      if (response?.sections) await this.recordFact({ type: "window_observation", key: `window:${keyPart(target)}`, target, window: response.window, sections: response.sections });
      return this.recordFact({ type: "window_action", key: `window-action:${keyPart(target)}:${keyPart(action.params?.action || action.params?.operation || "act")}`, action: action.type, target, sections: response?.sections || {}, at: Date.now() });
    }
    if (["fishbone_mine", "mine_vein", "chop_tree", "build_workarea", "build_base", "workshop"].includes(action?.type) && response) {
      const taskId = task?.id || action?.params?.anchor || action?.params?.name || action.type;
      const count = Number(response.currentCount ?? response.gained ?? response.completed ?? 0);
      const goal = Number(response.targetCount ?? response.requested ?? 0);
      const status = response.targetReached === false ? "尚未达到目标" : response.targetReached === true || response.complete === true ? "目标已完成" : "动作已返回";
      return this.upsert({
        kind: "progress",
        key: `work:${taskId}`,
        summary: `${action.type}：${status}${goal ? `，进度 ${count}/${goal}` : ""}`,
        detail: { taskId, action: action.type, params: action.params || {}, result: response },
        importance: response.targetReached === false ? 0.98 : 0.82,
        tags: ["work", action.type, response.targetReached === false ? "incomplete" : "verified"],
        source: "action"
      });
    }
    return null;
  }

  async recordReflection({ document = "", lessons = [], nextHints = [] } = {}) {
    this.latestSummary = { document: String(document).slice(0, 12000), lessons: lessons.map(item => trim(item, 500)).slice(0, 20), nextHints: nextHints.map(item => trim(item, 500)).slice(0, 20), updatedAt: Date.now() };
    for (const lesson of lessons.slice(0, 20)) {
      const text = trim(lesson, 500);
      if (text) await this.upsert({ kind: "lesson", key: `lesson:${keyPart(text)}`, summary: text, detail: { lesson: text }, importance: 0.86, tags: ["lesson", "reflection"], source: "reflection" });
    }
    for (const hint of nextHints.slice(0, 10)) {
      const text = trim(hint, 500);
      if (text) await this.upsert({ kind: "hint", key: `hint:${keyPart(text)}`, summary: text, detail: { hint: text }, importance: 0.68, tags: ["hint", "reflection"], source: "reflection" });
    }
    await this.save();
    this.events.emit("memory-archive-output", { summary: this.latestSummary, count: this.entries.length });
    return this.snapshot();
  }

  snapshot({ limit = 36 } = {}) {
    const groups = ["hint", "observation", "lesson", "failure", "window_action"].map(kind => this.entries.filter(item => item.kind === kind).sort((a, b) => b.lastSeenAt - a.lastSeenAt));
    const entries = [];
    while (entries.length < limit && groups.some(group => group.length)) {
      for (const group of groups) if (group.length && entries.length < limit) entries.push({ ...group.shift() });
    }
    return { entries, latestSummary: this.latestSummary, updatedAt: this.latestSummary?.updatedAt || entries.reduce((max, item) => Math.max(max, item.lastSeenAt || 0), 0) || 0, notes: ["这是跨轮次的长期记忆，只保留窗口观察、失败原因、经验教训和下一步提示。", "先验证记忆是否仍适用于当前坐标、目标和时间，再决定是否复用。"] };
  }

  contextSnapshot({ limit = 24 } = {}) {
    const entries = this.entries
      .filter(item => item.source !== "reflection" && item.kind !== "lesson" && item.kind !== "hint")
      .sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0) || Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0))
      .slice(0, limit)
      .map(item => ({ ...item }));
    return { entries, updatedAt: entries.reduce((max, item) => Math.max(max, item.lastSeenAt || 0), 0), notes: ["仅包含经筛选的运行记忆；Reflection 调试总结不会进入模型上下文。", "复用前先确认记忆仍适用于当前坐标、目标和环境。"] };
  }
}

export { factToEntry };
