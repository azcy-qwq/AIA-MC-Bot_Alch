import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../src/core/events.js";
import { DebugStore } from "../src/debug/debug-store.js";
import { DebugServer } from "../src/debug/debug-server.js";
import { OpenAICompatibleProvider } from "../src/llm/provider.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HumanTraceStore } from "../src/debug/human-trace-store.js";

function worldModelStub() {
  const events = new EventBus();
  return { events, latest: {} };
}

test("Debug reflection shows the newest live document and keeps archive only as a restart fallback",()=>{
  const eventBus=new EventBus();let archived={document:"old",updatedAt:100};
  const store=new DebugStore({worldModel:worldModelStub(),eventBus,memoryArchive:{snapshot:()=>({latestSummary:archived}),contextSnapshot:()=>({entries:[]})}});
  assert.equal(store.snapshot().reflection.document,"old");
  eventBus.emit("reflection-output",{document:"live",lessons:[],updatedAt:200});
  assert.equal(store.snapshot().reflection.document,"live");
  archived={document:"newer archive",updatedAt:300};
  assert.equal(store.snapshot().reflection.document,"newer archive");store.close();
});

test("Strategy prompt contains the layer-specific surrounding environment", async () => {
  let payload;
  const provider = new OpenAICompatibleProvider({
    baseUrl: "http://llm.test/v1",
    apiKey: "test-key",
    model: "test-model",
    fetchImpl: async (_url, options) => {
      payload = JSON.parse(options.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"rationale":"ok","tasks":[],"delegation":[]}' } }] }) };
    }
  });
  provider.budget = { session: () => null, reserve: () => null, settle() {} };
  await provider.createPlan({ context: { status: { position: [1, 2, 3] }, risks: { risks: ["nearby_hostile"] } }, activePlan: null });
  const userPayload = JSON.parse(payload.messages[1].content);
  assert.equal(userPayload.layer, "distribution");
  assert.match(payload.messages[0].content, /只返回合法 JSON/);
  assert.match(payload.messages[0].content, /dig_many/);
  assert.doesNotMatch(payload.messages[0].content, /chat、/);
  assert.deepEqual(userPayload.layer_context.status.position, [1, 2, 3]);
  assert.deepEqual(userPayload.layer_context.risks.risks, ["nearby_hostile"]);
});

test("Debug store records strategy, tool and Tac streams", () => {
  const eventBus = new EventBus();
  const store = new DebugStore({ worldModel: worldModelStub(), eventBus });
  eventBus.emit("strategy-output", { plan: { rationale: "test" }, context: { status: {} } });
  eventBus.emit("llm-trace", { type: "llm-response", usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
  eventBus.emit("llm-trace", { type: "llm-response", usage: { input_tokens: 30, output_tokens: 10, total_tokens: 40 } });
  eventBus.emit("action-preflight", { source: "action:torch", action: { type: "craft", params: { item: "torch", count: 32 } }, ok: false, known: true, item: "torch", requested: 32, crafts: 8, outputPerCraft: 4, missing: [{ item: "coal", need: 8, available: 5 }], inventory: { items: [{ name: "charcoal", count: 5 }] } });
  eventBus.emit("action-end", { action: { type: "dig" }, source: "test", result: { ok: true } });
  eventBus.emit("emergency", { kind: "lava", actions: [] });
  store.addAgentOutput({ agent: "miner", output: "done" });
  const state = store.snapshot();
  assert.equal(state.plans.length, 1);
  assert.equal(state.toolCalls.length, 2);
  assert.equal(state.toolCalls[0].type, "preflight");
  assert.equal(state.toolCalls[0].ok, false);
  assert.ok(state.timeline.some(item => item.label === "Action 材料检查拒绝"));
  assert.equal(state.tacEvents.length, 1);
  assert.equal(state.agentOutputs.length, 1);
  assert.equal(state.tokenUsage.prompt, 130);
  assert.equal(state.tokenUsage.completion, 30);
  assert.equal(state.tokenUsage.total, 160);
  assert.equal(state.tokenUsage.requests, 2);
  assert.equal(state.tokenUsage.byProvider.unknown.total, 160);
  assert.equal(state.tokenUsage.cacheReportedRequests, 0);
  assert.equal(state.layers.strategy.status, "success");
  assert.equal(state.layers.tac.status, "alert");
  assert.equal(state.layers.action.status, "success");
  assert.ok(state.timeline.some(item => item.layer === "strategy" && item.label.includes("输出计划")));
  assert.ok(state.timeline.some(item => item.layer === "tac" && item.label.includes("紧急")));
  store.close();
});

test("Debug server serves the dashboard and JSON state", async () => {
  const server = new DebugServer({ store: { snapshot: () => ({ status: "online" }) }, port: 0 });
  const address = await server.start();
  const html = await (await fetch(`${address}/`)).text();
  const state = await (await fetch(`${address}/api/debug/state`)).json();
  assert.match(html, /Agent 调试台/);
  assert.equal(state.status, "online");
  await server.stop();
});

test("Debug server stays available when Agent startup fails", async () => {
  const server = new DebugServer({ store: { snapshot: () => ({ status: "error" }) }, port: 0, onStart: async () => { throw new Error("simulated login failure"); } });
  const address = await server.start();
  const failedStart = await fetch(`${address}/api/runtime/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "test" }) });
  const failure = await failedStart.json();
  const state = await fetch(`${address}/api/debug/state`);
  assert.equal(failedStart.status, 400);
  assert.match(failure.error, /simulated login failure/);
  assert.equal(state.status, 200);
  await server.stop();
});

test("new-run endpoint forwards settings and rejects foreign-origin control requests", async () => {
  const calls = [];
  const server = new DebugServer({ store: { snapshot: () => ({ status: "stopped" }) }, port: 0, onNewSession: async input => { calls.push(input); return { ok: true, status: "online" }; } });
  const settings = { durationHours: 4, inputTokens: 8000000, outputTokens: 1500000, planningGoal: "附魔装备" };
  try {
    const address = await server.start();
    const sent = await fetch(`${address}/api/runtime/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });
    assert.equal(sent.status, 200); assert.deepEqual(calls, [settings]);
    const denied = await fetch(`${address}/api/runtime/session`, { method: "POST", headers: { Origin: "https://foreign.invalid", "Content-Type": "application/json" }, body: JSON.stringify(settings) });
    assert.equal(denied.status, 403); assert.equal(calls.length, 1);
  } finally { await server.stop(); }
});

test("new-run endpoint keeps the dashboard available on invalid settings", async () => {
  const server = new DebugServer({ store: { snapshot: () => ({ status: "stopped" }) }, port: 0, onNewSession: async () => { throw new Error("输入、输出Token上限都必须是正整数"); } });
  try {
    const address = await server.start();
    const failed = await fetch(`${address}/api/runtime/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(failed.status, 400); assert.match((await failed.json()).error, /正整数/);
    assert.equal((await fetch(`${address}/api/debug/state`)).status, 200);
  } finally { await server.stop(); }
});

test("Debug server accepts local hints and reflection refresh requests", async () => {
  const server = new DebugServer({
    store: { snapshot: () => ({ status: "online" }) },
    port: 0,
    onHint: async input => ({ ok: true, hint: { text: input.text } }),
    onReflection: async () => ({ document: "# 总结", lessons: ["减少重复动作"] })
  });
  const address = await server.start();
  const hintResponse = await fetch(`${address}/api/debug/hints`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "先确认目标" }) });
  const reflectionResponse = await fetch(`${address}/api/debug/reflection`, { method: "POST" });
  assert.equal(hintResponse.status, 200);
  assert.equal((await hintResponse.json()).hint.text, "先确认目标");
  assert.match((await reflectionResponse.json()).document, /总结/);
  await server.stop();
});

test("Human trace endpoint persists player actions and compares them with bot events", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-traces-"));
  const tracePath = path.join(dir, "human.jsonl");
  const botPath = path.join(dir, "bot.jsonl");
  const at = Date.now();
  await writeFile(botPath, `${JSON.stringify({ at: at + 800, type: "action-start", action: { type: "move_to" } })}\n${JSON.stringify({ at: at + 1200, type: "action-end", action: { type: "move_to" } })}\n`);
  const server = new DebugServer({ store: { snapshot: () => ({}) }, port: 0, humanTraces: new HumanTraceStore({ filePath: tracePath, botLogPath: botPath }) });
  try {
    const address = await server.start();
    const sent = await fetch(`${address}/api/traces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: "test-session", events: [{ eventId: "m1", at, type: "move", action: "forward", position: [1, 64, 1] }] }) });
    assert.equal(sent.status, 202);
    assert.equal((await sent.json()).accepted, 1);
    const comparison = await fetch(`${address}/api/traces/compare?sessionId=test-session&from=${at - 1}&to=${at + 5000}`);
    const result = await comparison.json();
    assert.equal(result.humanEvents, 1);
    assert.equal(result.botEvents, 2);
    assert.equal(result.counts.move.player, 1);
    assert.equal(result.counts.move.botStarted, 1);
    assert.equal(result.counts.move.botSucceeded, 1);
    assert.equal(result.pairs[0].nearestBotEvent.type, "action-end");
    assert.equal((await readFile(tracePath, "utf8")).includes('"sessionId":"test-session"'), true);
  } finally {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
