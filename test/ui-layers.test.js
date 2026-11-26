import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { DebugStore } from "../src/debug/debug-store.js";
import { EventBus } from "../src/core/events.js";

test("debug snapshots expose live queue order and the prepared next task", () => {
  const executor = { running: { action: { type: "dig" }, source: "action:one" }, queue: [{ action: { type: "craft" } }, { action: { type: "equip" } }] };
  const runner = { snapshot: () => ({ activeTask: { title: "采集" } }), queuedPlan: { planId: "next", tasks: [{ title: "建造", actions: [] }] } };
  const store = new DebugStore({ worldModel: { latest: {}, events: new EventBus() }, eventBus: new EventBus(), executor, runner });
  try {
    assert.deepEqual(store.snapshot().workQueue.pending.map(item => item.action.type), ["craft", "equip"]);
    assert.equal(store.snapshot().workQueue.nextPlan.tasks[0].title, "建造");
    executor.queue.shift();
    assert.deepEqual(store.snapshot().workQueue.pending.map(item => item.action.type), ["equip"]);
  } finally { store.close(); }
});

test("Distribution pending status uses its short task rather than Strategy mission", () => {
  const eventBus = new EventBus();
  const store = new DebugStore({ worldModel: { latest: {}, events: new EventBus() }, eventBus });
  try {
    eventBus.emit("strategic-output", { plan: { mission: "长期目标：准备下界" } });
    eventBus.emit("distribution-input", { context: { strategicPlan: { mission: "长期目标：准备下界" } } });
    let state = store.snapshot();
    assert.equal(state.lastDistribution, null);
    assert.doesNotMatch(state.layers.distribution.detail, /准备下界/);
    eventBus.emit("distribution-input", { context: { taskContinuity: { activeTask: { title: "收集木头" } } } });
    state = store.snapshot();
    assert.match(state.layers.distribution.detail, /收集木头/);
    assert.ok(state.lastDistributionInput.at);
    assert.ok(state.lastStrategic.at);
  } finally { store.close(); }
});

test("dashboard keeps each layer's output separate and labels previous Distribution output", async () => {
  const nodes = new Map();
  function node(key) {
    if (!nodes.has(key)) nodes.set(key, {
      textContent: "", innerHTML: "", addEventListener() {}, getContext: () => null,
      querySelector: child => node(`${key} ${child}`)
    });
    return nodes.get(key);
  }
  const context = vm.createContext({
    document: { querySelector: node, querySelectorAll: () => [] },
    localStorage: { getItem: () => null },
    fetch: async () => ({ ok: false }), setInterval() {}, Date
  });
  vm.runInContext(await readFile(new URL("../ui/app.js", import.meta.url), "utf8"), context);
  context.state = {
    lastStrategic: { at: 1000, plan: { mission: "长期目标：准备下界", objectives: [] } },
    lastStrategy: { plan: { rationale: "旧 Strategy 文本不能回填" } },
    layers: { distribution: { status: "running", detail: "长期目标：准备下界" } }
  };
  vm.runInContext("renderStrategy(state); renderFlow(state)", context);
  assert.equal(node("#strategic-mission").textContent, "长期目标：准备下界");
  assert.match(node("#rationale").textContent, /尚无 Distribution 输出/);
  assert.doesNotMatch(node("#rationale").textContent, /准备下界|旧 Strategy/);
  assert.doesNotMatch(node('.layer-node[data-layer="distribution"] .layer-detail').textContent, /准备下界/);
  context.state.lastDistribution = { at: 2000, plan: { rationale: "木材不足", tasks: [{ title: "收集木头", goal: "背包达到32原木" }] } };
  vm.runInContext("renderStrategy(state)", context);
  assert.match(node("#rationale").textContent, /上次分发：收集木头/);
  assert.match(node("#plan-age").textContent, /上次输出.*新一轮分发中/);
  context.state.workQueue = { running: { action: { type: "dig", params: { pos: [1, 64, 0] } }, source: "action:wood" }, pending: [{ action: { type: "craft", params: { item: "stick" } }, source: "action:wood" }], nextPlan: { tasks: [{ title: "挖矿", actions: [{ type: "mine_vein" }] }] } };
  vm.runInContext("renderQueue(state)", context);
  assert.match(node("#work-queue").innerHTML, /正在执行.*dig/);
  assert.match(node("#work-queue").innerHTML, /待执行 1.*craft/);
  assert.match(node("#work-queue").innerHTML, /下一任务.*挖矿/);
});
