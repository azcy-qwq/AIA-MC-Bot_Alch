import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../src/core/events.js";
import { StrategicEngine } from "../src/strategy/strategic-engine.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("StrategicEngine produces long-horizon objectives separately from distribution actions", async () => {
  const events = new EventBus();
  let received;
  const engine = new StrategicEngine({
    eventBus: events,
    provider: { createStrategy: async input => (received = input, { mission: "建立安全矿洞路线", objectives: [{ id: "mine", title: "建立矿洞", goal: "持续获得铁和煤", priority: 80 }], route: ["基地", "矿洞入口"] }) }
  });
  const plan = await engine.replan({ status: { alive: true, ready: true }, inventory: {}, entities: [], events: [] }, { force: true, distribution: { planId: "d1" } });
  assert.equal(plan.mission, "建立安全矿洞路线");
  assert.equal(plan.objectives[0].id, "mine");
  assert.equal(received.context.layer, "strategic");
  assert.equal(received.distribution.planId, "d1");
});

test("StrategicEngine restores its long-term plan after restart", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-strategy-"));
  const filePath = path.join(dir, "runtime-state.json");
  try {
    const first = new StrategicEngine({ filePath, provider: { createStrategy: async () => ({ mission: "准备下矿", objectives: [{ id: "mine", title: "下矿", goal: "到达矿洞", priority: 80 }] }) } });
    await first.replan({ status: { alive: true, ready: true }, inventory: {}, entities: [], events: [] }, { force: true });
    const restored = new StrategicEngine({ filePath, provider: { createStrategy: async () => { throw new Error("should wait for the restored interval"); } } });
    await restored.load();
    const plan = await restored.replan({ status: { alive: true, ready: true }, inventory: {}, entities: [], events: [] });
    assert.equal(plan.mission, "准备下矿");
    assert.equal(plan.objectives[0].id, "mine");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
