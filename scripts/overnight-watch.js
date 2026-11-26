import { appendFile, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { notifyProgress } from "./progress-notify.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const base = `http://127.0.0.1:${process.env.DEBUG_UI_PORT || 4173}`;
let lastRecovery = 0, lastHint = 0, lastProgress = Date.now(), unavailable = 0;
const visited = new Set();
let bestMissing = Infinity;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function request(url, init = {}, timeout = 10000) { const response = await fetch(`${base}${url}`, { ...init, signal: AbortSignal.timeout(timeout) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`); return data; }
const journal = entry => appendFile("data/overnight-progress.jsonl", JSON.stringify({ at: Date.now(), ...entry }) + "\n");
while (true) {
  const session = JSON.parse(await readFile("data/debug-session.json", "utf8"));
  if (!session.active || Date.now() >= session.deadline) {
    await request("/api/runtime/stop", { method: "POST" }, 25000).catch(() => {});
    try { await notifyProgress(await request("/api/debug/state"), { force: true, title: "Minecraft 本轮调试结束", note: "调试窗口已结束，Agent 已停止，UI 保留。实际进度与未完成问题见 docs/enchanting-four-hour-20261115.md。" }); } catch (error) { await journal({ type: "notify-error", message: error.message }); }
    await journal({ type: "session-ended", reason: "调试窗口已结束，停止 Agent，保留 UI" });
    await writeFile("data/debug-session.json", JSON.stringify({ ...session, active: false, endedAt: Date.now() }, null, 2));
    break;
  }
  try {
    const state = await request("/api/debug/state"); unavailable = 0;
    try { const result = await notifyProgress(state);if (result.sent) await journal({ type: "qq-notified" }); } catch (error) { await journal({ type: "notify-error", message: error.message }); }
    const env = state.environment || {}, inventory = env.inventory?.items || [];
    const counts = inventory.reduce((result, item) => { result[item.name] = (result[item.name] || 0) + item.count; return result; }, {});
    // Repeated left/right walks and surplus stone must not disguise a stall.
    const pos = env.status?.pos;
    const region = Array.isArray(pos) ? [env.status.dimension, Math.floor(pos[0] / 5), Math.floor(pos[1]), Math.floor(pos[2] / 5)].join(":") : null;
    const missing = env.mission?.missing?.length ?? Infinity;
    if ((region && !visited.has(region)) || missing < bestMissing) lastProgress = Date.now();
    if (region) visited.add(region);
    bestMissing = Math.min(bestMissing, missing);
    await journal({ type: "health", status: state.status, position: env.status?.pos, health: env.status?.health, food: env.status?.food, task: state.lastDistribution?.plan?.tasks?.[0]?.title, action: state.layers?.action, mission: env.mission?.missing, inventory: counts, lastError: state.lastError, workerPid: state.supervisor?.workerPid, sessionStartedAt:session.startedAt, automation:state.automation, budget:state.sessionBudget, xpLevel:env.status?.xp_level, armor:env.inventory?.armor, running:state.workQueue?.running?.action });
    const stale = env.observedAt && Date.now() - env.observedAt > 60000;
    if ((state.status === "error" || (state.status === "online" && stale)) && Date.now() - lastRecovery > 180000) {
      lastRecovery = Date.now(); await journal({ type: "restarting", reason: stale ? "环境观测超过一分钟未更新" : state.lastError });
      await request("/api/runtime/restart", { method: "POST" }, 180000);
    } else if (state.status === "online" && !state.workQueue?.running && !(state.workQueue?.pending || []).length && !["thinking", "running"].includes(state.layers?.distribution?.status) && Date.now()-lastHint>180000 && Date.now()-lastProgress>180000 && state.sessionBudget?.input < (state.sessionBudget?.limits?.input || Infinity)) {
      lastHint=Date.now();
      await request("/api/debug/hints",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text:session.planningGoal+" 队列持续为空，请基于当前故障与空间恢复；不重派已完成的任务。"})});
    }
  } catch (error) {
    await journal({ type: "watch-error", message: error.message }); unavailable++;
    if (unavailable === 3 && Date.now() - lastRecovery > 180000) {
      lastRecovery = Date.now();
      const child = spawn(process.execPath, ["src/debug/preview.js"], { cwd: root, detached: true, windowsHide: true, stdio: "ignore" });
      child.unref();
    }
  }
  await wait(30000);
}
