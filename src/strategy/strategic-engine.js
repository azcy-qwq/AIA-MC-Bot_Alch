import { EventBus } from "../core/events.js";
import { summarizeEnvironment } from "../core/environment-summary.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { TACTICAL_REFERENCE, TACTICAL_REVISION, STRATEGIC_INTERVAL_MS, EARLY_SURVIVAL_FLOW } from "./tactical-reference.js";
import { buildEarlyGameCraftingSnapshot } from "../action/crafting-tree.js";
import { SessionBudget } from "../llm/session-budget.js";

function normalizeStrategicPlan(input = {}) {
  const plan = {
    planId: input.planId || `strategic-${Date.now()}-${randomUUID()}`,
    mission: String(input.mission || input.rationale || "保持生存并逐步推进长期目标"),
    horizon: String(input.horizon || "长期"),
    objectives: Array.isArray(input.objectives) ? input.objectives.slice(0, 6).map(item => ({
      id: String(item.id || `objective-${Math.random().toString(36).slice(2, 8)}`),
      title: String(item.title || item.goal || "未命名目标"),
      goal: String(item.goal || item.title || ""),
      priority: Number(item.priority) || 0,
      status: String(item.status || "pending"),
      constraints: Array.isArray(item.constraints) ? item.constraints.map(String).slice(0, 8) : []
    })) : [],
    route: Array.isArray(input.route) ? input.route.slice(0, 12).map(String) : [],
    risks: Array.isArray(input.risks) ? input.risks.map(String).slice(0, 12) : [],
    principles: Array.isArray(input.principles) ? input.principles.map(String).slice(0, 12) : [],
    createdAt: Number(input.createdAt) || Date.now()
  };
  // Enchanting is an optional branch. Model output and restored plans may
  // still contain an older mandatory wording, so enforce the user-facing
  // contract at the boundary before Distribution sees the plan.
  const enchanting = /附魔|书架|enchant|bookshelf/i.test(`${plan.mission} ${plan.objectives.map(item => `${item.title} ${item.goal}`).join(" ")}`);
  if (enchanting) {
    if (!/可选/.test(plan.mission)) plan.mission = `可选附魔分支：${plan.mission}`;
    for (const objective of plan.objectives) {
      if (!/附魔|书架|enchant|bookshelf/i.test(`${objective.title} ${objective.goal}`)) continue;
      if (!objective.constraints.some(item => /可选|放弃|不阻塞|复用|保留已完成/.test(item))) objective.constraints.push("附魔可选：优先复用已观测设施；长时间材料或设施不足时保留已完成部分并放弃剩余，不阻塞主线");
    }
  }
  return plan;
}

export class StrategicEngine {
  constructor({ provider, eventBus = new EventBus(), sessionBudget = {}, minReplanMs = STRATEGIC_INTERVAL_MS, routeMemory = null, memory = null, memoryArchive = null, inventoryBrief = null, filePath = null } = {}) {
    this.provider = provider;
    this.events = eventBus;
    this.sessionBudget = sessionBudget;
    this.minReplanMs = minReplanMs;
    this.routeMemory = routeMemory;
    this.memory = memory;
    this.memoryArchive = memoryArchive;
    this.inventoryBrief = inventoryBrief;
    this.filePath = filePath;
    this.currentPlan = null;
    this.lastRunAt = 0;
    this.running = null;
  }

  async load() {
    if (!this.filePath) return this;
    try {
      const data = JSON.parse(await readFile(this.filePath, "utf8"));
      if (data.strategicPlan?.mission && data.tacticalRevision === TACTICAL_REVISION) {
        this.currentPlan = normalizeStrategicPlan(data.strategicPlan);
        // Give the restored plan one full strategic interval to guide
        // Distribution before asking the model to replace it.
        this.lastRunAt = Date.now();
        this.events.emit("strategic-output", { plan: this.currentPlan, restored: true });
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return this;
  }

  async save() {
    if (!this.filePath || !this.currentPlan) return this;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify({ version: 2, tacticalRevision: TACTICAL_REVISION, strategicPlan: this.currentPlan, savedAt: Date.now() }, null, 2), "utf8");
    await rename(tempPath, this.filePath);
    return this;
  }

  async replan(snapshot, { force = false, distribution = null } = {}) {
    if (!this.provider?.createStrategy) {
      if (!this.currentPlan) {
        this.currentPlan = normalizeStrategicPlan({ mission: "先确保生存，再逐步收集资源并建立可复用路线", objectives: [{ id: "survive", title: "维持生存", goal: "保持生命、食物和安全位置", priority: 100 }] });
        await this.save();
        this.events.emit("strategic-output", { raw: this.currentPlan, plan: this.currentPlan, context: { layer: "strategic", fallback: true } });
      }
      return this.currentPlan;
    }
    if (this.running) return this.running;
    if (!force && Date.now() - this.lastRunAt < this.minReplanMs) return this.currentPlan;
    this.lastRunAt = Date.now();
    this.running = (async () => {
      const context = summarizeEnvironment(snapshot, "strategy");
      context.layer = "strategic";
      context.primaryTacticalReference = TACTICAL_REFERENCE;
      context.earlySurvivalFlow = EARLY_SURVIVAL_FLOW;
      context.refreshIntervalMs = this.minReplanMs;
      context.debugHints = this.debugHints || [];
      context.distribution = distribution;
      context.activeStrategicPlan = this.currentPlan;
      context.craftingTree = buildEarlyGameCraftingSnapshot(snapshot?.inventory);
      if (this.inventoryBrief) context.inventoryQuickReference = await this.inventoryBrief(snapshot?.inventory);
      if (this.routeMemory) context.routeMemory = this.routeMemory.snapshot();
      if (this.memory) context.memory = this.memory.snapshot();
      if (this.memoryArchive) context.memoryArchive = this.memoryArchive.contextSnapshot();
      if(new SessionBudget(this.sessionBudget).session()?.tokenBudget){
        const routes=context.routeMemory||{};context.routeMemory={anchors:Array.isArray(routes.anchors)?routes.anchors.slice(0,10):Object.fromEntries(Object.entries(routes.anchors||{}).slice(0,10)),note:"完整路线由C++本地恢复"};
        context.memory={facts:(context.memory?.facts||[]).slice(-8)};
        context.memoryArchive={entries:(context.memoryArchive?.entries||[]).slice(0,8).map(e=>({kind:e.kind,summary:String(e.summary||"").slice(0,300)}))};
      }
      this.events.emit("strategic-input", { context, activePlan: this.currentPlan });
      try {
        const raw = await this.provider.createStrategy({ snapshot, context, activePlan: this.currentPlan, distribution });
        const plan = normalizeStrategicPlan(raw);
        this.currentPlan = plan;
        await this.save();
        this.events.emit("strategic-output", { raw, plan, context });
        return plan;
      } catch (error) {
        this.events.emit("strategic-error", { error, context });
        throw error;
      }
    })().finally(() => { this.running = null; });
    return this.running;
  }
}

export { normalizeStrategicPlan };
