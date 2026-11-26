import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, assertCredentials } from "../config.js";
import { loadLaunchConfig, saveLaunchConfig } from "./config-vault.js";
import { readFile } from "node:fs/promises";
import { SessionBudget } from "../llm/session-budget.js";
import { createRunSession, validateRunSession } from "./run-session.js";

const WORKER = fileURLToPath(new URL("./runtime-worker.js", import.meta.url));
const filled = value => typeof value === "string" && value.trim().length > 0;
const connectionIdentity = value => String(value || "").trim().replace(/\/+$/, "");
export function mergeLaunchConfig(base, saved = {}, input = null) {
  saved ||= {};
  const config = { ...base, ...saved, api: { ...base.api, ...saved.api }, intervals: { ...base.intervals, ...saved.intervals }, llm: { ...base.llm, ...saved.llm }, sessionBudget: { ...base.sessionBudget, ...saved.sessionBudget } };
  for (const field of ["baseUrl", "apiKey", "model"]) if (!filled(config.llm[field]) && filled(base.llm?.[field])) config.llm[field] = base.llm[field];
  if (!input) return config;
  if (filled(input.username) && input.username.trim() !== config.api.username && !filled(input.password)) throw new Error("更换游戏账号时请填写该账号密码");
  if (filled(input.llmBaseUrl) && connectionIdentity(input.llmBaseUrl) !== connectionIdentity(config.llm.baseUrl) && !filled(input.llmApiKey)) throw new Error("更换模型服务地址时请重新填写 API Key，避免把原密钥发送到其他服务");
  for (const [source, target] of [["username", "username"], ["password", "password"], ["apiBaseUrl", "baseUrl"]]) if (filled(input[source])) config.api[target] = source === "password" ? input[source] : input[source].trim();
  for (const [source, target] of [["llmBaseUrl", "baseUrl"], ["llmApiKey", "apiKey"], ["llmModel", "model"]]) if (filled(input[source])) config.llm[target] = input[source].trim();
  return config;
}
const connectionFields = config => JSON.stringify([config?.api?.baseUrl, config?.api?.username, config?.api?.password, config?.llm?.baseUrl, config?.llm?.apiKey, config?.llm?.model]);
export class RuntimeSupervisor {
  constructor({ forkImpl = fork, persist = true, loadSaved = loadLaunchConfig, save = saveLaunchConfig, sessionFile = "data/debug-session.json", ledgerFile = "data/llm-session-budget.json", sessionOptions = {} } = {}) {
    this.fork = forkImpl; this.persist = persist; this.loadSaved = loadSaved; this.save = save;
    this.sessionFile = sessionFile; this.ledgerFile = ledgerFile; this.sessionOptions = sessionOptions;
    this.worker = null; this.config = null; this.operation = null; this.sequence = 0; this.pending = new Map();
    this.state = { status: "stopped", layers: {}, timeline: [], toolCalls: [], llmCalls: [], runtimeEvents: [] };
    this.autoRestart = false; this.restartCount = 0; this.retryTimer = null; this.stableTimer = null;
  }
  snapshot() { let sessionBudget=null;try{const budget=new SessionBudget({sessionFile:this.sessionFile,ledgerFile:this.ledgerFile}),session=budget.session();if(session?.tokenBudget){const ledger=budget.read(session);sessionBudget={...ledger,limits:session.tokenBudget,reserved:Object.values(ledger.reservations).reduce((n,r)=>({input:n.input+r.input,output:n.output+r.output}),{input:0,output:0})};delete sessionBudget.reservations;}}catch{}return { ...this.state, sessionBudget, supervisor: { restartCount: this.restartCount, autoRestart: this.autoRestart, workerPid: this.worker?.pid || null, session: this.session || null } }; }
  async readSession() {
    try { this.session = JSON.parse(await readFile(this.sessionFile, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; this.session = null; }
    return this.session;
  }
  async newSession(input) {
    return this.#exclusive(async () => {
      validateRunSession(input);
      if (this.worker) throw new Error("请先停止当前Agent，再开启新一轮；当前任务和预算保持不变");
      const config = mergeLaunchConfig(loadConfig(), this.config || await this.loadSaved(), input.config);
      assertCredentials(config);
      clearTimeout(this.retryTimer); this.retryTimer = null; this.autoRestart = false;
      const created = await createRunSession(input, { ...this.sessionOptions, sessionFile: this.sessionFile, ledgerFile: this.ledgerFile });
      this.session = created.session; this.restartCount = 0;
      try { return { ...await this.#start(null, config), session: this.session, archiveFile: created.archiveFile }; }
      catch (error) {
        this.autoRestart = false; clearTimeout(this.retryTimer); this.retryTimer = null;
        throw new Error(`新一轮已保存，但启动失败：${error.message}。修正后点击“继续本轮”，不会再次清零用量。`);
      }
    });
  }
  async start(input = null) {
    return this.#exclusive(async () => {
      if (!this.worker) return this.#start(input);
      const hasInput = input && Object.values(input).some(filled);
      if (!hasInput) return { ok: true, status: this.state.status };
      const config = mergeLaunchConfig(loadConfig(), this.config || await this.loadSaved(), input);
      assertCredentials(config);
      if (connectionFields(config) === connectionFields(this.config)) return { ok: true, status: this.state.status };
      await this.#stop();
      return { ...await this.#start(null, config), reconfigured: true };
    });
  }
  async #exclusive(fn) {
    if (this.operation) throw new Error("正在切换 Agent 状态，请稍后");
    this.operation = Promise.resolve().then(fn);
    try { return await this.operation; } finally { this.operation = null; }
  }
  async #start(input, resolved = null) {
    const base = loadConfig();
    this.config = resolved || mergeLaunchConfig(base, this.config || await this.loadSaved(), input);
    assertCredentials(this.config);
    await this.readSession();
    if (this.session?.active && this.session.tokenBudget) {
      this.config.llm = { ...this.config.llm, conversationMaxTurns: 1, conversationMaxChars: 24000 };
      this.config.intervals = { ...this.config.intervals, reflectionMs: 900000, reflectionMinMs: 900000 };
    }
    if (this.session?.deadline && Date.now() >= this.session.deadline) throw new Error("本轮调试窗口已结束，保持停止状态等待用户设置新窗口");
    this.config.debug = { ...base.debug, enabled: false };
    this.config.mission = { preNether: this.session?.active && this.session?.goal === "pre-nether" };
    if (this.persist && process.platform === "win32") await this.save(this.config);
    this.autoRestart = true;
    this.state = { ...this.state, status: "starting", lastError: null };
    const child = this.fork(WORKER, [], { windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    this.worker = child;
    child.on("message", message => {
      if (this.worker !== child) return;
      if (message.type === "state") this.state = message.state;
      if (message.type === "fatal") { this.state = { ...this.state, status: "error", lastError: message.error }; child.kill(); }
      if (message.type === "reply") {
        const pending = this.pending.get(message.id);
        if (pending) { clearTimeout(pending.timer); this.pending.delete(message.id); message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result); }
      }
    });
    child.on("error", error => { this.state.lastError = error.message; });
    const exited = () => {
      if (this.worker !== child) return;
      clearTimeout(this.stableTimer);
      this.worker = null;
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Agent 工作进程已退出")); } this.pending.clear();
      if (this.autoRestart) this.#retry();
    };
    child.on("exit", exited);
    child.on("close", exited);
    try {
      await this.call("start", { config: this.config }, 180000);
      this.stableTimer = setTimeout(() => { this.restartCount = 0; }, 120000);
      this.stableTimer.unref?.();
      return { ok: true, status: "online" };
    } catch (error) {
      this.state = { ...this.state, status: "error", lastError: error.message };
      if (this.worker === child) { child.kill(); exited(); }
      throw error;
    }
  }
  #retry() {
    if (this.retryTimer) return;
    if (!this.autoRestart || (this.session?.deadline && Date.now() >= this.session.deadline)) return;
    this.restartCount++;
    if (this.restartCount > 5) { this.autoRestart = false; this.state.lastError = "连续五次重启失败，已停止重试，请查看运行日志"; return; }
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.start().catch(() => { if (!this.worker) this.#retry(); }); }, Math.min(30000, 2000 * this.restartCount));
  }
  call(type, input = {}, timeoutMs = 20000) {
    if (!this.worker?.connected) return Promise.reject(new Error("Agent 尚未启动"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${type} 等待超时`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.send({ id, type, ...input }, error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
    });
  }
  async stop() {
    return this.#exclusive(() => this.#stop());
  }
  async #stop() {
    this.autoRestart = false; clearTimeout(this.retryTimer); this.retryTimer = null; clearTimeout(this.stableTimer);
    const child = this.worker;
    if (child) {
      await this.call("stop", {}, 15000).catch(() => {});
      this.worker = null;
      await new Promise(resolve => {
        if (child.exitCode !== null) return resolve();
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3000);
        child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill();
      });
    }
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("Agent 已停止")); } this.pending.clear();
    this.state = { ...this.state, status: "stopped" };
    return { ok: true, status: "stopped" };
  }
  async restart() {
    return this.#exclusive(async () => { await this.#stop(); return this.#start(null); });
  }
}
