import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OpenAICompatibleProvider } from "../src/llm/provider.js";
import { DebugStore } from "../src/debug/debug-store.js";
import { EventBus } from "../src/core/events.js";

function provider(options = {}) {
  const bodies = [];
  return { bodies, client: new OpenAICompatibleProvider({ baseUrl: "https://deepseek.test", apiKey: "not-a-real-key", model: "test", ...options, fetchImpl: async (_url, input) => { bodies.push(JSON.parse(input.body)); return { ok: true, json: async () => ({ choices: [{ message: { content: '{"tasks":[],"mission":"准备下界","lessons":[]}' } }] }) }; } }) };
}
test("same layer appends immutable turns while other layers keep separate histories", async () => {
  const { client, bodies } = provider();
  await client.createPlan({ context: { observedAt: 1 } });
  await client.createStrategy({ context: { observedAt: 1 } });
  await client.createPlan({ context: { observedAt: 2 } });
  assert.deepEqual(bodies[2].messages.slice(0, 2), bodies[0].messages);
  assert.equal(bodies[1].messages.length, 2);
  assert.equal(bodies[2].messages[2].role, "assistant");
  assert.equal(JSON.parse(bodies[2].messages[3].content).layer_context.observedAt, 2);
  assert.equal(bodies[0].prompt_cache_key, undefined);
});
test("conversation resumes across restart and rolls over at its configured bound", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "aia-chat-"));
  const options = { conversationFile: path.join(dir, "conversations.json"), conversationMaxTurns: 2 };
  try {
    await provider(options).client.createPlan({ context: { observedAt: 1 } });
    const second = provider(options);
    await second.client.createPlan({ context: { observedAt: 2 } });
    assert.equal(second.bodies[0].messages.length, 4);
    await second.client.createPlan({ context: { observedAt: 3, mission: "准备下界" } });
    assert.equal(second.bodies[1].messages.length, 2);
    assert.equal(JSON.parse(second.bodies[1].messages[1].content).layer_context.mission, "准备下界");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("cache usage is measured from API fields and reflection is separately counted", () => {
  const events = new EventBus(), worldModel = { events: new EventBus() };
  const store = new DebugStore({ worldModel, eventBus: events });
  events.emit("llm-trace", { type: "llm-response", provider: "distribution", usage: { prompt_tokens: 1000, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200, completion_tokens: 10 } });
  events.emit("llm-trace", { type: "llm-response", provider: "strategic", usage: { input_tokens: 500, input_tokens_details: { cached_tokens: 300 }, output_tokens: 20 } });
  events.emit("llm-trace", { type: "llm-response", provider: "reflection", usage: { prompt_tokens: 100, completion_tokens: 10 } });
  const usage = store.snapshot().tokenUsage;
  assert.equal(usage.total, 1530); assert.equal(usage.cachedPrompt, 1100); assert.equal(usage.uncachedPrompt, 400); assert.equal(usage.cacheReportedRequests, 2);
  assert.equal(usage.byProvider.reflection.total, 110); assert.equal(usage.requests, 2);
  store.close();
});
