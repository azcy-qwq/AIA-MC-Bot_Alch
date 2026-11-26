import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { RuntimeSupervisor, mergeLaunchConfig } from "../src/debug/runtime-supervisor.js";
import { loadConfig } from "../src/config.js";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function fixture(options = {}) {
  const children = [];
  const supervisor = new RuntimeSupervisor({ persist: false, loadSaved: async () => ({ api: { username: "test", password: "test" } }), forkImpl: () => {
    const child = new EventEmitter();
    Object.assign(child, { pid: 100 + children.length, connected: true, exitCode: null });
    child.send = (message, callback) => { callback?.(); setTimeout(() => child.emit("message", { type: "reply", id: message.id, result: { ok: true } }), 5); };
    child.kill = () => { child.exitCode = 0; child.connected = false; child.emit("exit", 0); child.emit("close", 0); };
    children.push(child); return child;
  }, ...options });
  if (!options.sessionFile) supervisor.readSession = async () => (supervisor.session = null);
  return { supervisor, children };
}

test("supervisor locks the entire restart and keeps a single worker", async () => {
  const { supervisor, children } = fixture();
  try {
    await supervisor.start();
    const restarting = supervisor.restart();
    await assert.rejects(supervisor.restart(), /正在切换/);
    await restarting;
    assert.equal(children.length, 2);
    assert.equal(children[0].connected, false);
    assert.equal(supervisor.snapshot().supervisor.workerPid, 101);
  } finally { await supervisor.stop(); }
});

test("supervisor schedules one retry for duplicate exit/close events and stop cancels it", async () => {
  const { supervisor, children } = fixture();
  await supervisor.start();
  children[0].kill();
  assert.equal(supervisor.restartCount, 1);
  assert.ok(supervisor.retryTimer);
  await supervisor.stop();
  assert.equal(supervisor.retryTimer, null);
  assert.equal(supervisor.autoRestart, false);
});

test("a successful start does not erase a rapid crash streak", async () => {
  const { supervisor } = fixture();
  supervisor.restartCount = 3;
  try { await supervisor.start(); assert.equal(supervisor.restartCount, 3); }
  finally { await supervisor.stop(); }
});

test("the run window deadline does not automatically stop an active bot", async () => {
  const { supervisor, children } = fixture();
  supervisor.readSession = async () => supervisor.session = { active: true, deadline: Date.now() + 25, tokenBudget: { input: 1000, output: 1000 } };
  try {
    await supervisor.start();
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(supervisor.worker, children[0]);
    assert.equal(children[0].connected, true);
    assert.equal(supervisor.autoRestart, true);
  } finally { await supervisor.stop(); }
});

test("an empty start request restores the saved encrypted configuration", async () => {
  const { supervisor } = fixture();
  try { await supervisor.start({}); assert.equal(supervisor.config.api.username, "test"); }
  finally { await supervisor.stop(); }
});

test("blank GUI secrets preserve the saved model and login configuration", () => {
  const saved = { api: { username: "test", password: "saved-password" }, llm: { baseUrl: "https://model.test/v1", model: "saved-model", apiKey: "saved-key" } };
  const config = mergeLaunchConfig(loadConfig({}), saved, { username: "test", password: "", llmBaseUrl: "https://model.test/v1", llmApiKey: "", llmModel: "" });
  assert.equal(config.api.password, "saved-password");
  assert.deepEqual(config.llm, { ...loadConfig({}).llm, ...saved.llm });
  assert.equal(saved.llm.apiKey, "saved-key");
});

test("updating a model key while online replaces the worker and applies it", async () => {
  const { supervisor, children } = fixture();
  try {
    await supervisor.start();
    const result = await supervisor.start({ llmBaseUrl: "https://model.test/v1", llmApiKey: "replacement-key", llmModel: "test-model" });
    assert.equal(result.reconfigured, true);
    assert.equal(children.length, 2);
    assert.equal(children[0].connected, false);
    assert.equal(supervisor.config.llm.apiKey, "replacement-key");
    const unchanged = await supervisor.start({ llmApiKey: "", password: "" });
    assert.equal(unchanged.ok, true);
    assert.equal(children.length, 2);
    assert.equal(supervisor.config.llm.apiKey, "replacement-key");
  } finally { await supervisor.stop(); }
});

test("changing model servers without a key does not stop the working agent", async () => {
  const { supervisor, children } = fixture();
  try {
    await supervisor.start({ llmBaseUrl: "https://model.test/v1", llmApiKey: "saved-key", llmModel: "test-model" });
    await assert.rejects(supervisor.start({ llmBaseUrl: "https://different.test/v1", llmApiKey: "" }), /重新填写 API Key/);
    assert.equal(children.length, 1);
    assert.equal(children[0].connected, true);
    assert.equal(supervisor.config.llm.apiKey, "saved-key");
  } finally { await supervisor.stop(); }
});

for (const active of [true,false]) test(`an expired session blocks startup even when active=${active}`,async()=>{
  const {supervisor,children}=fixture();supervisor.readSession=async()=>supervisor.session={active,deadline:Date.now()-1000};
  await assert.rejects(supervisor.start(),/窗口已结束/);assert.equal(children.length,0);assert.equal(supervisor.autoRestart,false);
});

test("a newly configured future session can start after the expired session is replaced",async()=>{
  const {supervisor,children}=fixture();let deadline=Date.now()-1000;supervisor.readSession=async()=>supervisor.session={active:true,deadline};
  await assert.rejects(supervisor.start(),/窗口已结束/);deadline=Date.now()+60000;
  try{await supervisor.start();assert.equal(children.length,1);}finally{await supervisor.stop();}
});

test("new-session control replaces an expired window once; restart preserves its ledger and deadline", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-session-supervisor-"));
  const sessionFile = path.join(dir, "session.json"), ledgerFile = path.join(dir, "ledger.json"), archiveDir = path.join(dir, "archive");
  const { supervisor, children } = fixture({ sessionFile, ledgerFile, sessionOptions: { archiveDir, reportDir: path.join(dir, "docs") } });
  try {
    await writeFile(sessionFile, JSON.stringify({ active: false, startedAt: 1, deadline: 2 }));
    await assert.rejects(supervisor.start(), /窗口已结束/);
    const settings = { durationHours: 4, inputTokens: 8000000, outputTokens: 1500000, planningGoal: "附魔装备" };
    const starting = supervisor.newSession(settings);
    await assert.rejects(supervisor.newSession(settings), /正在切换/);
    const result = await starting;
    assert.equal(result.ok, true); assert.equal(children.length, 1);
    const session = JSON.parse(await readFile(sessionFile, "utf8"));
    assert.equal(supervisor.snapshot().sessionBudget.input, 0);
    await assert.rejects(supervisor.newSession(settings), /先停止/);
    assert.equal((await readdir(archiveDir)).length, 1);
    const ledger = { startedAt: session.startedAt, input: 250, output: 25, requests: 1, byLayer: {}, reservations: {} };
    await writeFile(ledgerFile, JSON.stringify(ledger));
    await supervisor.restart();
    assert.equal(children.length, 2);
    assert.deepEqual(JSON.parse(await readFile(sessionFile, "utf8")), session);
    assert.deepEqual(JSON.parse(await readFile(ledgerFile, "utf8")), ledger);
    assert.equal(supervisor.snapshot().sessionBudget.input, 250);
  } finally { await supervisor.stop(); await rm(dir, { recursive: true, force: true }); }
});

test("bad credentials do not replace the current window when opening a new run", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-session-config-")), sessionFile = path.join(dir, "session.json");
  const { supervisor, children } = fixture({ sessionFile, loadSaved: async () => ({}) });
  try {
    await writeFile(sessionFile, '{"active":false,"deadline":1}');
    await assert.rejects(supervisor.newSession({ durationHours: 4, inputTokens: 8e6, outputTokens: 1.5e6, planningGoal: "附魔装备", config: { llmBaseUrl: "https://changed.invalid/v1" } }));
    assert.equal(await readFile(sessionFile, "utf8"), '{"active":false,"deadline":1}'); assert.equal(children.length, 0);
  } finally { await supervisor.stop(); await rm(dir, { recursive: true, force: true }); }
});

test("a failed new-round login keeps the saved window and allows resume without a second archive", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-session-login-")), sessionFile = path.join(dir, "session.json"), archiveDir = path.join(dir, "archive");
  const { supervisor, children } = fixture({ sessionFile, ledgerFile: path.join(dir, "ledger.json"), sessionOptions: { archiveDir, reportDir: path.join(dir, "docs") } });
  const call = supervisor.call.bind(supervisor);
  supervisor.call = (type, ...rest) => type === "start" ? Promise.reject(new Error("simulated login failure")) : call(type, ...rest);
  try {
    await writeFile(sessionFile, '{"active":false,"startedAt":1,"deadline":2}');
    await assert.rejects(supervisor.newSession({ durationHours: 4, inputTokens: 8e6, outputTokens: 1.5e6, planningGoal: "附魔装备" }), /已保存.*启动失败.*继续本轮/);
    assert.equal(supervisor.worker, null); assert.equal(supervisor.autoRestart, false); assert.equal(supervisor.retryTimer, null);
    const session = await readFile(sessionFile, "utf8");
    supervisor.call = call; await supervisor.start();
    assert.equal(children.length, 2); assert.equal(await readFile(sessionFile, "utf8"), session); assert.equal((await readdir(archiveDir)).length, 1);
  } finally { await supervisor.stop(); await rm(dir, { recursive: true, force: true }); }
});
