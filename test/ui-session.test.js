import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function ui() {
  const nodes = new Map(), requests = [];
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { value: "", textContent: "", disabled: false, listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback; }, reportValidity: () => true });
    return nodes.get(id);
  }
  const context = vm.createContext({ document: { querySelector: node, querySelectorAll: () => [] }, localStorage: { getItem: () => null, setItem() {} }, fetch: async (url, options) => {
    requests.push({ url, options });
    return url === "/api/runtime/session" ? { ok: true, json: async () => ({ ok: true }) } : { ok: false };
  }, setInterval() {}, Date });
  vm.runInContext(await readFile(new URL("../ui/app.js", import.meta.url), "utf8"), context);
  return { node, context, requests };
}

test("expired window disables ordinary restart and offers a new round without modifying user input on polling", async () => {
  const { node, context } = await ui();
  context.state = { supervisor: { workerPid: null, session: { startedAt: 1, deadline: 14400001, active: false, planningGoal: "附魔", tokenBudget: { input: 8000000, output: 1500000 } } }, sessionBudget: { input: 5000, output: 100 } };
  vm.runInContext("renderSessionControls(state)", context);
  assert.equal(node("#session-state").textContent, "运行窗口已结束");
  assert.equal(node("#start-agent").disabled, true); assert.equal(node("#restart-agent").disabled, true);
  assert.equal(node("#new-session").disabled, false); assert.equal(node("#session-hours").value, "4");
  node("#session-hours").value = "2"; node("#session-goal").value = "用户编辑";
  vm.runInContext("renderSessionControls(state)", context);
  assert.equal(node("#session-hours").value, "2"); assert.equal(node("#session-goal").value, "用户编辑");
  context.state.supervisor.workerPid = 123; context.state.supervisor.session.active = true; context.state.supervisor.session.deadline = Date.now() + 60000;
  vm.runInContext("renderSessionControls(state)", context);
  assert.equal(node("#new-session").disabled, true); assert.equal(node("#stop-agent").disabled, false);
});

test("an expired planning window keeps the current bot visible and offers manual stop", async () => {
  const { node, context } = await ui();
  context.state = { supervisor: { workerPid: 123, session: { startedAt: 1, deadline: Date.now() - 1, active: true, planningGoal: "挖矿", tokenBudget: { input: 8000000, output: 1500000 } } }, sessionBudget: { input: 5000, output: 100 } };
  vm.runInContext("renderSessionControls(state)", context);
  assert.equal(node("#session-state").textContent, "预算窗口已到期，当前脚本继续运行");
  assert.equal(node("#start-agent").disabled, true);
  assert.equal(node("#restart-agent").disabled, true);
  assert.equal(node("#stop-agent").disabled, false);
  assert.equal(node("#new-session").disabled, true);
});

test("unlimited-token sessions show usage without a ceiling", async () => {
  const { node, context } = await ui();
  context.state = { supervisor: { workerPid: 123, session: { startedAt: 1, deadline: Date.now() + 60000, active: true, planningGoal: "挖矿" } }, sessionBudget: { input: 5000, output: 100 } };
  vm.runInContext("renderSessionControls(state)", context);
  assert.equal(node("#session-state").textContent, "运行中 · Token 不限额");
  assert.match(node("#session-summary").textContent, /Token 不限额/);
  assert.equal(node("#session-unlimited").checked, true);
  assert.equal(node("#session-input").disabled, true);
});

test("new-round button sends explicit duration, separate budgets and goal only when clicked", async () => {
  const { node, requests } = await ui();
  assert.equal(requests.filter(x => x.url === "/api/runtime/session").length, 0);
  node("#session-hours").value = "4"; node("#session-input").value = "8000000"; node("#session-output").value = "1500000"; node("#session-goal").value = " 附魔装备 ";
  await node("#new-session").listeners.click();
  const call = requests.find(x => x.url === "/api/runtime/session"), payload = JSON.parse(call.options.body);
  assert.equal(payload.durationHours, 4); assert.equal(payload.inputTokens, 8000000); assert.equal(payload.outputTokens, 1500000); assert.equal(payload.planningGoal, "附魔装备");
  assert.match(node("#control-error").textContent, /新一轮已启动/);
});

test("new-round button sends an unlimited token setting when selected", async () => {
  const { node, requests } = await ui();
  node("#session-hours").value = "4"; node("#session-goal").value = "持续采矿"; node("#session-unlimited").checked = true;
  await node("#new-session").listeners.click();
  const call = requests.find(x => x.url === "/api/runtime/session"), payload = JSON.parse(call.options.body);
  assert.equal(payload.unlimitedTokens, true);
});
