import path from "node:path";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRuntime } from "./runtime.js";
import { loadConfig } from "./config.js";
import { EventBus } from "./core/events.js";

const cleanName = value => String(value || "").trim();
const safeId = value => cleanName(value).toLowerCase().replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "bot";
function isolatedConfig(base, definition, stateRoot) {
  const name = cleanName(definition.name || definition.id);
  if (!name) throw Object.assign(new Error("多 bot 配置缺少 name"), { code: "bad_bot_config" });
  const id = safeId(definition.id || name);
  const root = path.resolve(stateRoot, id);
  mkdirSync(root, { recursive: true });
  const config = structuredClone(base);
  config.botName = name;
  config.botId = id;
  config.api = {
    ...config.api,
    baseUrl: definition.url || definition.baseUrl || definition.apiBaseUrl || config.api.baseUrl,
    username: definition.username ?? config.api.username,
    password: definition.password ?? config.api.password
  };
  config.debug = { ...config.debug, enabled: false };
  config.llm = { ...config.llm, conversationFile: path.join(root, "llm-conversations.json") };
  const sourceSession = definition.sessionFile || base.sessionBudget?.sessionFile || "data/debug-session.json";
  const sessionFile = path.join(root, "debug-session.json");
  if (existsSync(sourceSession) && !existsSync(sessionFile)) copyFileSync(sourceSession, sessionFile);
  config.sessionBudget = { sessionFile, ledgerFile: path.join(root, "llm-session-budget.json") };
  config.routes = { ...config.routes, filePath: path.join(root, "routes.json") };
  config.memory = { ...config.memory, filePath: path.join(root, "strategy-memory.json") };
  config.memoryArchive = { ...config.memoryArchive, filePath: path.join(root, "memory-archive.json") };
  config.distributionState = { ...config.distributionState, filePath: path.join(root, "distribution-state.json") };
  config.runtimeState = { ...config.runtimeState, filePath: path.join(root, "runtime-state.json") };
  config.progress = { ...config.progress, filePath: path.join(root, "progress-state.json") };
  config.reflection = { ...config.reflection, filePath: path.join(root, "reflection-latest.json") };
  config.native = { ...config.native, stateFile: path.join(root, "native-state.json") };
  config.timing = { ...config.timing, filePath: path.join(root, "task-timing-model.json"), journalPath: path.join(root, "task-timing-samples.jsonl") };
  return config;
}

/**
 * Runs independent bot runtimes from one shared codebase. Every runtime owns
 * its API connection, state files, memory, native bridge and action queue.
 * Calls for different bots are started concurrently; a single bot remains
 * serial because its game connection cannot execute two actions at once.
 */
export class MultiBotRuntime {
  constructor({ bots = [], config = loadConfig(), stateRoot = "data/bots", runtimeFactory = createRuntime, eventBus = new EventBus() } = {}) {
    this.eventBus = eventBus;
    this.records = new Map();
    this.runtimeFactory = runtimeFactory;
    for (const definition of bots) this.add(definition, { config, stateRoot });
  }

  add(definition, { config = loadConfig(), stateRoot = "data/bots" } = {}) {
    const normalized = isolatedConfig(config, definition, stateRoot);
    const id = normalized.botId;
    if (this.records.has(id)) throw Object.assign(new Error(`重复的 bot id: ${id}`), { code: "duplicate_bot" });
    const runtime = this.runtimeFactory({ config: normalized });
    const record = { id, name: normalized.botName, config: normalized, runtime, status: "stopped", error: null };
    runtime.events?.on("started", () => { record.status = "online"; record.error = null; this.eventBus.emit("bot-started", { id, name: record.name }); });
    runtime.events?.on("stopped", () => { record.status = "stopped"; this.eventBus.emit("bot-stopped", { id, name: record.name }); });
    runtime.events?.on("error", error => { record.error = { code: error.code, message: error.message }; this.eventBus.emit("bot-error", { id, name: record.name, error: record.error }); });
    this.records.set(id, record);
    return record;
  }

  get size() { return this.records.size; }
  get(id) { return this.records.get(cleanName(id)) || [...this.records.values()].find(record => record.name === cleanName(id)); }

  async startBot(id, options) {
    const record = this.get(id);
    if (!record) throw Object.assign(new Error(`未知 bot: ${id}`), { code: "unknown_bot" });
    try { const result = await record.runtime.start(options); record.status = "online"; return { id: record.id, name: record.name, ...result }; }
    catch (error) { record.status = "error"; record.error = { code: error.code, message: error.message }; throw error; }
  }

  async stopBot(id, options) {
    const record = this.get(id);
    if (!record) throw Object.assign(new Error(`未知 bot: ${id}`), { code: "unknown_bot" });
    const result = await record.runtime.stop(options); record.status = "stopped"; return { id: record.id, name: record.name, ...result };
  }

  async startAll(options) {
    const entries = [...this.records.values()];
    return Promise.allSettled(entries.map(record => this.startBot(record.id, options))).then(results => results.map((result, index) => ({ id: entries[index].id, name: entries[index].name, ...result })));
  }

  async stopAll(options) {
    const entries = [...this.records.values()];
    return Promise.allSettled(entries.map(record => this.stopBot(record.id, options))).then(results => results.map((result, index) => ({ id: entries[index].id, name: entries[index].name, ...result })));
  }

  /** Enqueue one native skill on a selected bot without sharing queues. */
  enqueue(id, action, options = {}) {
    const record = this.get(id);
    if (!record) return Promise.reject(Object.assign(new Error(`未知 bot: ${id}`), { code: "unknown_bot" }));
    return record.runtime.executor.enqueue(action, { ...options, source: options.source || `bot:${record.id}` });
  }

  snapshot() {
    return [...this.records.values()].map(record => ({ id: record.id, name: record.name, status: record.status, error: record.error, runtime: record.runtime.executor?.snapshot?.() || null }));
  }
}

export function createMultiBotRuntime(options = {}) { return new MultiBotRuntime(options); }
