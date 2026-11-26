import { EventBus } from "../core/events.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionBudget } from "../llm/session-budget.js";

function heuristicSummary({ events = [], hints = [], currentPlan } = {}) {
  const failures = events.filter(item => ["error", "action-error", "strategy-error", "distribution-error", "strategic-error", "runtime-warning", "danger"].includes(item.type)).slice(-12);
  const successes = events.filter(item => item.type === "success" || item.type === "action-end" || item.type === "strategy-output").slice(-12);
  const lessons = failures.map(item => {
    const detail = item.detail || item.error?.message || "出现失败，需要下一轮重新评估";
    if (/equip|invalid destination/i.test(`${item.action?.type || ""} ${detail}`)) return `装备接口格式错误：equip.slot 必须使用 hand、off-hand、head、torso、legs 或 feet，不能传背包槽位数字；先根据物品名称推断装备栏位。原始错误：${detail}`;
    return `${item.type}：${detail}`;
  });
  if (!lessons.length) lessons.push("当前没有记录到新的失败事件。");
  const hintLines = hints.length ? hints.map(item => `- ${item.text}`).join("\n") : "- 暂无人工调试提示";
  const document = `# Minecraft Agent 运行总结\n\n## 当前计划\n${currentPlan?.rationale || "暂无计划摘要"}\n\n## 经验教训\n${lessons.map(item => `- ${item}`).join("\n")}\n\n## 人工提示\n${hintLines}\n\n## 最近成功\n${successes.length ? successes.map(item => `- ${item.type}`).join("\n") : "- 暂无"}`;
  return { document, lessons, nextHints: lessons.slice(0, 5) };
}

export class ReflectionEngine {
  constructor({ provider, eventBus = new EventBus(), sessionBudget = {}, minIntervalMs = 90000, filePath = null } = {}) {
    this.provider = provider;
    this.events = eventBus;
    this.sessionBudget = sessionBudget;
    this.minIntervalMs = minIntervalMs;
    this.running = null;
    this.lastRunAt = 0;
    this.document = "尚未生成运行总结。";
    this.lessons = [];
    this.nextHints = [];
    this.filePath = filePath;
    this.lastFailureFingerprint = null;
  }

  async load() {
    if (!this.filePath) return;
    try {
      const saved = JSON.parse(await readFile(this.filePath, "utf8"));
      this.document = String(saved.document || "");
      this.lessons = Array.isArray(saved.lessons) ? saved.lessons.map(String) : [];
      this.nextHints = Array.isArray(saved.nextHints) ? saved.nextHints.map(String) : [];
      this.lastRunAt = Number(saved.updatedAt) || 0;
      this.lastFailureFingerprint = saved.lastFailureFingerprint || null;
      this.events.emit("reflection-output", this.snapshot());
    } catch (error) { if (error.code !== "ENOENT") this.events.emit("reflection-error", { error: { code: error.code, message: "读取调试反思失败：" + error.message } }); }
  }

  async save() {
    if (!this.filePath) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(`${this.filePath}.tmp`, JSON.stringify(this.snapshot()), "utf8");
    await rename(`${this.filePath}.tmp`, this.filePath);
  }

  async summarize(input = {}, { force = false } = {}) {
    if (this.running) return this.running;
    if (!force && Date.now() - this.lastRunAt < this.minIntervalMs) return this.snapshot();
    this.running = (async () => {
      this.events.emit("reflection-start", { at: Date.now() });
    const budgetSession = new SessionBudget(this.sessionBudget).session()?.tokenBudget;
      const failures = (input.events || []).filter(e => ["action-error", "action-warning", "distribution-error", "error"].includes(e.type) || e.layer === "action" && e.type === "error");
      const fingerprint = JSON.stringify(failures.slice(-3).map(e => [e.at, e.error?.code, e.detail]));
      const needsModel = !budgetSession || failures.length > 0 && fingerprint !== this.lastFailureFingerprint;
      const result = needsModel && this.provider?.createReflection ? await this.provider.createReflection(input) : heuristicSummary(input);
      this.lastFailureFingerprint = fingerprint;
      this.document = String(result.document || "");
      this.lessons = Array.isArray(result.lessons) ? result.lessons.map(String) : [];
      this.nextHints = Array.isArray(result.nextHints) ? result.nextHints.map(String) : [];
      this.lastRunAt = Date.now();
      const output = this.snapshot();
      await this.save();
      this.events.emit("reflection-output", output);
      return output;
    })().catch(error => {
      this.events.emit("reflection-error", { error: { message: error.message, code: error.code } });
      return this.snapshot();
    }).finally(() => { this.running = null; });
    return this.running;
  }

  snapshot() { return { document: this.document, lessons: this.lessons, nextHints: this.nextHints, updatedAt: this.lastRunAt, lastFailureFingerprint:this.lastFailureFingerprint }; }
}
