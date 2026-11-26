import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../src/core/events.js";
import { NativeDistribution } from "../src/native/distribution.js";
import { OpenAICompatibleProvider } from "../src/llm/provider.js";
import { DebugStore } from "../src/debug/debug-store.js";

test("missing model key is visible as a Distribution error, not a successful empty plan", async () => {
  const events = new EventBus();
  const store = new DebugStore({ worldModel: { events: new EventBus(), latest: {} }, eventBus: events });
  const provider = new OpenAICompatibleProvider({ baseUrl: "https://model.test/v1", model: "test-model", apiKey: "", fetchImpl: () => { throw new Error("must not request without a key"); } });
  const distribution = new NativeDistribution({ provider, eventBus: events, memory: { snapshot: () => ({}) }, memoryArchive: { contextSnapshot: () => ({}) }, filePath: null });
  try {
    await assert.rejects(distribution.replan({}), error => error.code === "llm_not_configured");
    const state = store.snapshot();
    assert.equal(state.layers.distribution.status, "error");
    assert.match(state.layers.distribution.detail, /缺少API Key/);
    assert.equal(state.lastDistribution, null);
    assert.equal(distribution.currentPlan, null);
    assert.equal(distribution.running, null);
  } finally { store.close(); }
});

test("unsupported providers do not silently emit empty Distribution plans", async () => {
  const events = new EventBus();let failure;
  events.on("distribution-error", data => { failure = data.error; });
  const distribution = new NativeDistribution({ provider: {}, eventBus: events, memory: { snapshot: () => ({}) }, memoryArchive: { contextSnapshot: () => ({}) }, filePath: null });
  await assert.rejects(distribution.replan({}), error => error.code === "llm_not_configured");
  assert.equal(failure.code, "llm_not_configured");
});
