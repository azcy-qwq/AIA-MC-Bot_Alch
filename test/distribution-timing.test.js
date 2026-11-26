import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventBus } from "../src/core/events.js";
import { NativeExecutor } from "../src/native/executor.js";
import { DistributionPrefetch } from "../src/scheduling/distribution-prefetch.js";
import { TimingModel, plannedWork } from "../src/scheduling/timing-model.js";

const delay = () => new Promise(resolve => setTimeout(resolve, 5));
const drain = async () => { for (let n = 0; n < 4; n++) await delay(); };
const plan = (id, type = "chop_tree", params = { targetCount: 10 }) => ({ planId: id, tasks: [{ id, title: id, actions: [{ type, params }] }] });
function fixture(type = "chop_tree", params = { targetCount: 10 }) {
  let now = 1000, calls = 0;
  const events = new EventBus(), runs = [];
  const bridge = { run(type, params, { onProgress }) {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    runs.push({ type, params, onProgress, resolve, reject });
    return { promise, cancel: async () => reject(Object.assign(new Error("cancelled"), { code: "cancelled" })) };
  } };
  const executor = new NativeExecutor({ bridge, eventBus: events });
  const model = new TimingModel({ filePath: null, journalPath: null, now: () => now });
  model.observeDistribution({ model: "test", durationMs: 2000, success: true });
  const snapshot = { status: { pos: [0, 64, 0], dimension: "overworld" }, inventory: { items: [{ name: "stone_pickaxe", count: 1 }] } };
  const scheduler = new DistributionPrefetch({ model, modelName: "test", eventBus: events, executor, getSnapshot: () => snapshot, canPrefetch: () => !executor.paused, now: () => now, requestPlan: async () => {
    calls++; return plan("next", "mark_anchor", { name: "home" });
  } });
  executor.enqueuePlan(plan("first", type, params));
  return { executor, model, scheduler, events, runs, calls: () => calls, advance: ms => now += ms };
}

test("timing model learns startup plus per-unit duration, persists and excludes failed runs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-timing-"));
  try {
    const options = { filePath: path.join(dir, "model.json"), journalPath: path.join(dir, "samples.jsonl") };
    const model = new TimingModel(options), key = "staircase_down|stone|overworld|";
    for (const units of [1, 2, 4, 6, 8, 12]) model.observeAction({ key, units, durationMs: 2000 + units * 3000, success: true });
    model.observeAction({ key, units: 2, durationMs: 1000000, success: false, errorCode: "cancelled" });
    model.observeDistribution({ model: "test", durationMs: 40000, success: true, inputChars: 9000 });
    await model.flush();
    const restored = new TimingModel(options); await restored.load();
    const estimate = restored.predict(key, 10);
    assert.equal(estimate.source, "weighted-linear"); assert.ok(Math.abs(estimate.expectedMs - 32000) < 1);
    assert.equal(estimate.samples, 6); assert.equal(restored.data.counts.failures, 1);
    assert.equal(restored.distributionEstimate("test").leadMs, 42000);
    const records = (await readFile(options.journalPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(records.length, 8); assert.equal(records.at(-1).kind, "distribution");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("slow generation increases lookahead; failures do not count as successful plans", () => {
  const model = new TimingModel({ filePath: null, journalPath: null });
  for (const durationMs of [1000, 2000, 3000, 40000]) model.observeDistribution({ model: "x", durationMs, success: true });
  model.observeDistribution({ model: "x", durationMs: 60000, success: false, errorCode: "llm_timeout" });
  const estimate = model.distributionEstimate("x");
  assert.equal(estimate.samples, 4); assert.equal(estimate.leadMs, 62000);
  assert.equal(model.distributionEstimate("other-model").samples, 0);
});

test("prefetch caches outside the queue and releases only after current work finishes", async () => {
  const f = fixture();
  try {
    f.advance(1000); f.runs[0].onProgress({ phase: "gather", workCompleted: 1, workTotal: 10 });
    await drain(); assert.equal(f.calls(), 0);
    f.advance(5000); f.runs[0].onProgress({ phase: "gather", workCompleted: 6, workTotal: 10 });
    await drain(); assert.equal(f.calls(), 1); assert.equal(f.runs.length, 1); assert.equal(f.executor.queue.length, 0);
    assert.equal(f.scheduler.snapshot().pendingPlan.planId, "next");
    for (let n = 0; n < 8; n++) f.scheduler.tick();
    await drain(); assert.equal(f.calls(), 1);
    f.runs[0].resolve({ result: {}, state: {} }); await drain();
    assert.equal(f.runs.length, 2); assert.equal(f.runs[1].type, "mark_anchor"); assert.equal(f.scheduler.lastHandoff.gapMs, 0);
  } finally { await f.scheduler.close(); }
});

test("fishbone accounts for main AND branches; prefetch never interrupts mining", async () => {
  const f = fixture("fishbone_mine", { laneId: "7", length: 6, branchLength: 2, branchEvery: 3 });
  try {
    assert.equal(plannedWork(f.runs[0], {}), 14);
    f.advance(6000); f.runs[0].onProgress({ phase: "fishbone_main", workCompleted: 6, workTotal: 14, completed: 6, total: 6 });
    await drain(); assert.equal(f.calls(), 0);
    f.advance(5000); f.runs[0].onProgress({ phase: "fishbone_branch", workCompleted: 11, workTotal: 14 });
    await drain(); assert.equal(f.calls(), 1); assert.equal(f.runs.length, 1);
    f.runs[0].resolve({ result: { stopReason: "lane_complete" }, state: {} }); await drain();
    assert.equal(f.runs[1].type, "mark_anchor");
  } finally { await f.scheduler.close(); }
});

test("failure discards dependent prefetch and never teaches early exit as success", async () => {
  const f = fixture();
  try {
    f.advance(6000); f.runs[0].onProgress({ phase: "gather", workCompleted: 8, workTotal: 10 });
    await drain(); assert.equal(f.calls(), 1);
    f.runs[0].reject(Object.assign(new Error("no tool"), { code: "missing_tool" })); await drain();
    assert.equal(f.executor.queue.length, 0); assert.equal(f.runs.length, 1);
    assert.equal(f.model.data.counts.failures, 1); assert.equal(f.model.predict("chop_tree|none|overworld|", 10).samples, 0);
  } finally { await f.scheduler.close(); }
});

test("stalled progress is not counted down as successful completion", async () => {
  const f = fixture();
  try {
    f.advance(1000); f.runs[0].onProgress({ phase: "gather", workCompleted: 1, workTotal: 10 });
    f.advance(60000); f.scheduler.tick(); await drain();
    assert.equal(f.calls(), 0); assert.equal(f.scheduler.snapshot().work.stalled, true);
  } finally { await f.scheduler.close(); }
});

test("pending ordinary work delays prefetch until the queue approaches completion", async () => {
  const f = fixture();
  try {
    f.executor.enqueuePlan(plan("still-current-work", "staircase_down", { steps: 8 }));
    f.advance(6000); f.runs[0].onProgress({ phase: "gather", workCompleted: 9, workTotal: 10 });
    await drain(); assert.equal(f.calls(), 0); assert.ok(f.scheduler.snapshot().work.remainingMs > 50000);
  } finally { await f.scheduler.close(); }
});
