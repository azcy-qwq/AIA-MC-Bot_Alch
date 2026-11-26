import { createRuntime } from "../runtime.js";
import { EventBus } from "../core/events.js";
import { appendTaskReport } from "./task-report.js";
import { createEquipmentAudit } from "./equipment-audit.js";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";

let runtime = null, timer = null, journal = Promise.resolve(), sending = false;
const send = value => { if (process.connected) process.send(value); };
function log(type, data = {}) {
  const combat = data.action?.type === "jump_attack" || data.action?.type === "combat";
  const entry = { at: data.at || data.startedAt || data.endedAt || Date.now(), type, action: data.action, source: data.source, planId: data.planId, queueLength: data.queueLength, taskCount: data.taskCount, warning: data.warning, reason: data.reason, error: data.error ? { message: data.error.message, code: data.error.code, details: data.error.details } : undefined, detail: data.message || data.detail, durationMs: data.durationMs, plan: type === "strategic-output" ? data.plan : undefined, lessons: data.lessons, ...(type === "equipment-observation" ? { equipment:data.equipment,previous:data.previous,position:data.position,health:data.health,observedAt:data.observedAt,workerPid:process.pid } : {}), ...(combat && data.result ? {result:data.result}:{}), ...(combat && ["combat_strike","combat_finished"].includes(data.progress?.phase) ? {progress:data.progress}: {}) };
  journal = journal.catch(() => {}).then(async () => {
    await mkdir("data", { recursive: true });
    const file = "data/runtime-events.jsonl";
    if ((await stat(file).catch(() => ({ size: 0 }))).size > 5_000_000) await rename(file, `${file}.previous`).catch(() => {});
    await appendFile(file, JSON.stringify(entry) + "\n");
  });
}
function publish() {
  if (!runtime || sending || !process.connected) return;
  sending = true;
  process.send({ type: "state", state: runtime.debug.store.snapshot() }, () => { sending = false; });
}
process.on("message", async message => {
  const { id, type, config, input } = message;
  try {
    if (type === "start") {
      const events = new EventBus();
      for (const event of ["action-start", "action-error", "action-warning", "action-end", "distribution-error", "distribution-plan-enqueued", "distribution-plan-enqueue-skipped", "distribution-plan-empty", "distribution-plan-discarded", "distribution-plan-duplicate-ignored", "strategic-error", "runtime-warning", "error", "death", "respawned", "mission-ready", "strategic-output", "reflection-output", "runtime-stop-begin", "runtime-game-disconnected"]) events.on(event, data => log(event, data));
      events.on("action-progress", data => { if (["combat_strike","combat_finished"].includes(data.progress?.phase)) log("combat-observation",data);else if(["combat_protection_handoff","protection_retreat","protection_hold","protection_safe","regeneration_unavailable"].includes(data.progress?.phase))log("protection-observation",{...data,detail:JSON.stringify(data.progress)}); });
      events.on("action-progress",data=>{if(["shore_landing_plan","shore_landing_cut","shore_landing_excavated","shore_landing_unavailable","shore_reached"].includes(data.progress?.phase))log("shore-observation",{...data,detail:JSON.stringify(data.progress)});});
      events.on("action-progress",data=>{if(["surface_resource_scan","surface_cane_harvested","surface_resource_deferred","surface_animal_hunted","surface_animal_deferred"].includes(data.progress?.phase))log("resource-observation",{...data,detail:JSON.stringify(data.progress)});});
      events.on("tac-preempt",data=>log("tac-preempt",{at:data.at,reason:`${data.from} -> ${data.to}`,detail:`priority=${data.priority}`}));
      for(const event of ["tac-protection-blocked","tac-protection-cleared"])events.on(event,data=>log(event,{reason:data.kind,error:data.error,warning:data.warning}));
      events.on("native-api", data => { if(["equip","drop","windowAct"].includes(data.method)) log("equipment-api", {at:Date.now(),action:{type:data.method,params:data.params},source:data.source,planId:data.planId,durationMs:data.durationMs,error:data.error,reason:data.ok?"confirmed":"failed"}); });
      runtime = createRuntime({ config, eventBus: events });
      runtime.worldModel.events.on("snapshot", createEquipmentAudit(data => log("equipment-observation", data)));
      for(const kind of ["task-complete","task-error","task-warning"])events.on(kind,data=>{const snapshot=runtime.debug.store.snapshot();journal=journal.catch(()=>{}).then(()=>appendTaskReport(kind,data,snapshot)).catch(error=>log("task-report-warning",{detail:error.code||"report_write_failed"}));});
      try { runtime.debug.store.state.tokenUsage = JSON.parse(await readFile("data/token-usage.json", "utf8")); }
      catch (error) { if (error.code !== "ENOENT") log("usage-load-warning", { detail: "Token 统计恢复失败，开始新的统计" }); }
      events.on("llm-trace", data => {
        if (data.type !== "llm-response") return;
        const usage = JSON.stringify(runtime.debug.store.state.tokenUsage);
        journal = journal.catch(() => {}).then(async () => { await mkdir("data", { recursive: true }); await writeFile("data/token-usage.json.tmp", usage); await rename("data/token-usage.json.tmp", "data/token-usage.json"); });
      });
      timer = setInterval(publish, 1000); publish();
      runtime.distribution.addDebugHint("继续使用持久化的长期记忆、阶段账本、已记录工作点和未完成任务。每次恢复时用当前公开 API 的服务器、维度、坐标、背包、装备和生命状态核验哪些记忆仍适用；除明确死亡事件或确认切换到另一服务器/世界外，不清除已完成阶段，也不要把装备进箱、升级替换或短暂 API 错误当成进度回退。若当前状态与记忆矛盾，标明冲突并先核实，不要擅自按新世界重开。Tac 由独立 C++ 监控负责保命；不要为测试假报成功，不进入下界。");
      try {
        const session = JSON.parse(await readFile("data/debug-session.json", "utf8"));
        if (session.active && Date.now() < session.deadline && session.planningGoal) runtime.distribution.addDebugHint(`${session.planningGoal}\n最新修正：附魔是可选分支；先复用定向设施扫描发现的现成附魔台和书架。材料或设施长期不足时保留已完成的附魔并放弃剩余，不得阻塞采集、采矿或生存主线。`);
      } catch (error) { if (error.code !== "ENOENT") log("session-goal-warning", { detail: "调试会话目标读取失败，保留默认目标" }); }
      runtime.strategy.debugHints = runtime.distribution.debugHints;
      await runtime.start();
      publish();
    } else if (type === "stop") {
      clearInterval(timer); if (runtime) await runtime.stop(); await journal;
    } else if (type === "hint") {
      if (!runtime) throw new Error("Agent 尚未启动");
      const hint = runtime.distribution.addDebugHint(input.text); send({ type: "reply", id, result: { ok: true, hint } }); return;
    } else if (type === "reflection") {
      if (!runtime) throw new Error("Agent 尚未启动");
      const state = runtime.debug.store.snapshot();
      const result = await runtime.reflection.summarize({ environment: state.environment, events: [...state.timeline, ...state.toolCalls.filter(x => x.type === "error")], hints: runtime.distribution.debugHints, currentPlan: runtime.distribution.currentPlan, strategicPlan: runtime.strategy.currentPlan, memoryArchive: runtime.memoryArchive.snapshot() }, { force: true });
      send({ type: "reply", id, result }); return;
    } else if (type === "space") {
      if (!runtime) throw new Error("Agent 尚未启动");
      runtime.worldModel.invalidateSpatial();
      const result = await runtime.worldModel.refreshSpatial();
      send({ type: "reply", id, result }); publish(); return;
    }
    send({ type: "reply", id, result: { ok: true } });
  } catch (error) {
    log("worker-error", { error });
    send({ type: "reply", id, error: error.message || String(error) });
  }
});
for (const kind of ["uncaughtException", "unhandledRejection"]) process.on(kind, error => {
  log(kind, { error }); send({ type: "fatal", error: `${kind}: ${error?.message || error}` });
  setTimeout(() => process.exit(1), 100).unref();
});
process.on("disconnect", () => { clearInterval(timer); runtime?.stop().finally(() => process.exit(0)); });
