const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const pretty = value => esc(JSON.stringify(value, null, 2));
const time = value => value ? new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--";
const number1 = value => Number.isFinite(Number(value)) ? Number(value).toFixed(1) : "--";
let showRaw = false;
const CONFIG_STORAGE_KEY = "minecraft-agent-debug-config";
const controlDialog = $("#control-dialog");
let sessionFormKey, controlBusy = false;
const launchInput = () => ({ username: $("#mc-username").value, password: $("#mc-password").value, apiBaseUrl: $("#api-base-url").value, llmBaseUrl: $("#llm-base-url").value, llmApiKey: $("#llm-api-key").value, llmModel: $("#llm-model").value });
function renderSessionControls(state) {
  const session = state.supervisor?.session, running = Boolean(state.supervisor?.workerPid);
  const expired = Boolean(session && (!session.active || Date.now() >= session.deadline));
  $("#session-state").textContent = !session ? "尚未设置运行窗口" : expired && running ? session.tokenBudget ? "预算窗口已到期，当前脚本继续运行" : "运行窗口已到期，当前脚本继续运行" : expired ? "运行窗口已结束" : running ? session.tokenBudget ? "本轮运行中" : "运行中 · Token 不限额" : "本轮已停止，可继续";
  const usageSummary = session?.tokenBudget ? `输入 ${Number(state.sessionBudget?.input || 0).toLocaleString()} / ${Number(session.tokenBudget.input).toLocaleString()} · 输出 ${Number(state.sessionBudget?.output || 0).toLocaleString()} / ${Number(session.tokenBudget.output).toLocaleString()}` : `Token 不限额 · 当前输入 ${Number(state.sessionBudget?.input || 0).toLocaleString()} · 输出 ${Number(state.sessionBudget?.output || 0).toLocaleString()}`;
  $("#session-summary").textContent = !session ? "请填写运行时长和目标；Token 上限可选。" : `本轮截止 ${new Date(session.deadline).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}（北京时间） · ${usageSummary}${expired && running ? "。新的模型请求已停；当前 C++ 脚本继续。请手动停止，或停止后开启新窗口。" : expired ? "。请使用“开启新一轮并启动”。" : "。继续或重启不会清零用量。"}`;
  const key = session?.startedAt || "none";
  if (sessionFormKey !== key) {
    sessionFormKey = key;
    if (session) {
      $("#session-hours").value = String(Math.round((session.deadline - session.startedAt) / 3600000 * 100) / 100);
      $("#session-input").value = String(session.tokenBudget?.input || 8000000);
      $("#session-output").value = String(session.tokenBudget?.output || 1500000);
      $("#session-unlimited").checked = !session.tokenBudget;
      $("#session-goal").value = session.planningGoal || "";
    }
  }
  const unlimited = $("#session-unlimited").checked;
  $("#session-input").disabled = unlimited;
  $("#session-output").disabled = unlimited;
  $("#session-input").required = !unlimited;
  $("#session-output").required = !unlimited;
  $("#start-agent").disabled = controlBusy || expired;
  $("#restart-agent").disabled = controlBusy || expired;
  $("#stop-agent").disabled = controlBusy || !running;
  $("#new-session").disabled = controlBusy || running;
}
function setControlBusy(value) {
  controlBusy = value;
  if (render.lastState) renderSessionControls(render.lastState);
  else for (const id of ["start-agent", "restart-agent", "stop-agent", "new-session"]) $(`#${id}`).disabled = value;
}
function loadSavedConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_STORAGE_KEY) || "{}");
    delete saved["mc-password"];
    delete saved["llm-api-key"];
    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(saved));
    for (const [key, value] of Object.entries(saved)) {
      const input = document.querySelector(`#${key}`);
      if (input && typeof value === "string") input.value = value;
    }
  } catch { /* Ignore malformed browser-local settings. */ }
}
function saveConfig() {
  const config = {};
  for (const id of ["api-base-url", "mc-username", "llm-base-url", "llm-model"]) config[id] = document.querySelector(`#${id}`).value;
  localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
}
loadSavedConfig();
$("#session-unlimited").addEventListener("change", () => {
  const unlimited = $("#session-unlimited").checked;
  $("#session-input").disabled = unlimited;
  $("#session-output").disabled = unlimited;
  $("#session-input").required = !unlimited;
  $("#session-output").required = !unlimited;
});
$("#control-form").addEventListener("submit", event => event.preventDefault());
$("#close-control").addEventListener("click", () => controlDialog.close());
$("#restart-agent").addEventListener("click", async event => {
  setControlBusy(true);
  $("#control-error").textContent = "正在保存状态并载入更新…";
  try {
    const response = await fetch("/api/runtime/restart", { method: "POST" });
    const result = await response.json(); if (!response.ok || result.ok === false) throw new Error(result.error || "重启失败");
    $("#control-error").textContent = "Agent 已用更新后的代码重启。";
  } catch (error) { $("#control-error").textContent = error.message; }
  finally { await poll(); setControlBusy(false); }
});
$("#refresh-space").addEventListener("click", async event => {
  const button = event.currentTarget; button.disabled = true;
  try { const response = await fetch("/api/debug/space", { method: "POST" }); const result = await response.json(); if (!response.ok) throw new Error(result.error); await poll(); }
  catch (error) { $("#space-notes").textContent = error.message; }
  finally { button.disabled = false; }
});
$("#open-control").addEventListener("click", () => { if (render.lastState) renderSessionControls(render.lastState); controlDialog.showModal(); });
$("#start-agent").addEventListener("click", async event => {
  event.preventDefault();
  const error = $("#control-error");
  error.textContent = "正在应用配置并等待 Agent 就绪…";
  setControlBusy(true);
  try {
    const response = await fetch("/api/runtime/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(launchInput()) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) throw new Error(body.error || `启动失败 (${response.status})`);
    saveConfig();
    $("#mc-password").value = "";
    $("#llm-api-key").value = "";
    error.textContent = body.reconfigured ? "配置已保存并应用，Agent 已重新启动。" : "Agent 已启动（留空的密码和密钥沿用已保存配置）。";
    setTimeout(() => controlDialog.close(), 500);
  } catch (err) { error.textContent = err.message; }
  finally { await poll(); setControlBusy(false); }
});
$("#new-session").addEventListener("click", async () => {
  for (const id of ["session-hours", "session-goal", ...($("#session-unlimited").checked ? [] : ["session-input", "session-output"])]) if (!$(`#${id}`).reportValidity()) return;
  setControlBusy(true); $("#control-error").textContent = "正在归档上一轮并启动新一轮…";
  try {
    const response = await fetch("/api/runtime/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ durationHours: Number($("#session-hours").value), unlimitedTokens: $("#session-unlimited").checked, inputTokens: Number($("#session-input").value), outputTokens: Number($("#session-output").value), planningGoal: $("#session-goal").value.trim(), config: launchInput() }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) throw new Error(result.error || `开启失败 (${response.status})`);
    saveConfig(); $("#mc-password").value = ""; $("#llm-api-key").value = "";
    $("#control-error").textContent = "新一轮已启动；上一轮记录已归档，当前窗口重新计时。";
  } catch (error) { $("#control-error").textContent = error.message; }
  finally { await poll(); setControlBusy(false); }
});
$("#stop-agent").addEventListener("click", async () => {
  setControlBusy(true);
  const error = $("#control-error");
  error.textContent = "正在停止…";
  try {
    const response = await fetch("/api/runtime/stop", { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `停止失败 (${response.status})`);
    error.textContent = "Agent 已停止。";
  } catch (err) { error.textContent = err.message; }
  finally { await poll(); setControlBusy(false); }
});
$("#send-debug-hint").addEventListener("click", async () => {
  const input = $("#debug-hint-input");
  const button = $("#send-debug-hint");
  if (!input.value.trim()) return;
  button.disabled = true;
  try {
    const response = await fetch("/api/debug/hints", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: input.value.trim() }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) throw new Error(body.error || `添加失败 (${response.status})`);
    input.value = "";
    await poll();
  } catch (error) {
    input.setCustomValidity(error.message);
    input.reportValidity();
    input.setCustomValidity("");
  } finally { button.disabled = false; }
});
$("#run-reflection").addEventListener("click", async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await fetch("/api/debug/reflection", { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `总结失败 (${response.status})`);
    render.lastState && render({ ...render.lastState, reflection: body });
  } catch (error) {
    $("#reflection-document").textContent = error.message;
  } finally { button.disabled = false; }
});

document.querySelectorAll(".tab").forEach(button => button.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach(item => item.classList.toggle("active", item === button));
  document.querySelectorAll(".view").forEach(view => view.classList.toggle("active", view.id === `view-${button.dataset.tab}`));
}));
$("#toggle-context").addEventListener("click", event => {
  const element = $("#strategy-context");
  element.classList.toggle("collapsed");
  event.target.textContent = element.classList.contains("collapsed") ? "展开 JSON" : "收起 JSON";
});
$("#toggle-raw").addEventListener("click", event => { showRaw = !showRaw; event.target.textContent = showRaw ? "隐藏原始模型内容" : "显示原始模型内容"; if (render.lastState) render(render.lastState); });

function renderOverview(state) {
  const status = state.environment?.status || {};
  const risks = state.lastDistributionInput?.context?.risks?.risks || [];
  $("#connection-state").textContent = state.status === "online" ? "已连接比赛服" : state.status === "dead" ? "Bot 已死亡，等待重生" : state.status === "respawning" ? "等待 Bot 重生" : state.status === "stopped" ? "Agent 已停止" : state.status;
  if (state.status === "error" && state.lastError) $("#connection-state").textContent = `运行异常：${state.lastError}`;
  $("#updated-at").textContent = time(state.environment?.observedAt);
  $("#health").textContent = number1(status.health);
  $("#food").textContent = number1(status.food);
  $("#health-meta").textContent = `${number1(status.armor_points)} 护甲`;
  $("#food-meta").textContent = `${number1(status.saturation)} 饱和`;
  $("#location").textContent = status.dimension || "--";
  $("#coordinates").textContent = status.pos ? status.pos.map(Number).map(value => value.toFixed(1)).join(", ") : "位置未知";
  const actionLayer = state.layers?.action || {};
  const strategyLayer = state.layers?.distribution || {};
  $("#busy").textContent = state.status === "stopped" ? "Agent 已停止" : actionLayer.status === "running" ? actionLayer.detail || "Action 执行中" : strategyLayer.status === "running" ? "Distribution 分发中" : status.busy || "API 空闲";
  $("#runtime-status").textContent = state.status === "stopped" ? "显示停止前最后快照" : actionLayer.status === "running" ? "Action 执行中" : strategyLayer.status === "running" ? "模型规划中" : status.ready ? "API ready" : "等待 API";
  const tokens = state.tokenUsage || {};
  $("#token-total").textContent = Number(tokens.total || 0).toLocaleString();
  const providerNames = Object.entries(tokens.byProvider || {}).map(([name, item]) => `${name} ${item.total ? Number(item.total).toLocaleString() : "未提供"}`).join(" · ");
  $("#token-breakdown").textContent = `输入 ${Number(tokens.prompt || 0).toLocaleString()} · 输出 ${Number(tokens.completion || 0).toLocaleString()} · ${tokens.requests || 0} 次请求${providerNames ? ` · ${providerNames}` : ""}`;
  if(state.sessionBudget){const b=state.sessionBudget;$("#token-total").textContent=Number(b.input+b.output).toLocaleString();$("#token-breakdown").textContent=`本轮全层输入 ${Number(b.input).toLocaleString()} / ${Number(b.limits.input).toLocaleString()} · 输出 ${Number(b.output).toLocaleString()} / ${Number(b.limits.output).toLocaleString()} · 待结算预留 ${Number(b.reserved.input+b.reserved.output).toLocaleString()} · ${b.requests} 次（含 Reflection）`;}
  const automation = state.automation;
  $("#automation-ratio").textContent = automation ? `${Math.round((automation.busyRatio || 0) * 100)}%` : "--";
  $("#automation-time").textContent = automation ? `脚本 ${Math.round(automation.automatedMs / 60000)}分 · 等待 ${Math.round(automation.waitingMs / 60000)}分` : "自动化 / 等待";
  const riskLine = $("#risk-line");
  riskLine.classList.toggle("danger", risks.some(risk => ["in_lava", "critical_health", "dead"].includes(risk)));
  riskLine.classList.toggle("warning", risks.length > 0 && !riskLine.classList.contains("danger"));
  $("#risk-text").textContent = risks.length ? `重点：${risks.join("、")}` : "未发现需要立即处置的风险";
  const work = state.autonomousWork, queue = state.workQueue || {}, strategic = state.lastStrategic?.plan;
  const running = queue.running, task = state.lastDistribution?.plan?.tasks?.[0];
  const title = state.status === "stopped" ? "Agent 已停止" : work ? ({ chop_tree: "自动砍树", mine_vein: "自动采集矿脉", fishbone_mine: "鱼骨挖矿" }[running?.action?.type] || running?.action?.type || "自动化脚本") : running?.task?.title || task?.title || strategic?.mission || "等待任务分发";
  const detail = state.status === "stopped" ? `停止前最后记录：${running?.action?.type || task?.title || "没有正在执行的任务"}` : work ? `${work.phase || "持续执行"} · 已取得 ${work.currentCount ?? 0}/${work.targetCount ?? "?"}${work.failures?.length ? ` · 受阻 ${work.failures.length} 次` : ""}` : running ? `${running.source || "Action"} · ${running.action?.type || "脚本执行中"}` : task?.goal || "Distribution 将结合战略与当前环境决定下一项工作";
  const current = Number(work?.currentCount), target = Number(work?.targetCount);
  const percent = Number.isFinite(current) && Number.isFinite(target) && target > 0 ? Math.max(0, Math.min(100, current / target * 100)) : null;
  $("#focus-title").textContent = title;
  $("#focus-detail").textContent = detail;
  $("#focus-progress-bar").style.width = `${percent ?? 0}%`;
  $("#focus-progress-label").textContent = state.status === "stopped" ? "停止前最后进度" : percent == null ? (queue.pending?.length ? `队列 ${queue.pending.length} 项` : "等待脚本进度") : `${Math.round(percent)}% · 剩余约 ${Math.max(0, Math.ceil(Number(work.remainingMs || 0) / 1000))} 秒`;
}

function renderTokenRate(state) {
  const canvas = $("#token-rate-chart");
  const ctx = canvas?.getContext("2d");
  if (!ctx) return;
  const width = Math.max(1, canvas.clientWidth), height = Math.max(1, canvas.clientHeight), ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);canvas.height = Math.round(height * ratio);ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const now = Date.now(), start = Math.floor(now / 60000) * 60000 - 29 * 60000, values = Array(30).fill(0);
  for (const call of state.llmCalls || []) {
    if (call.type !== "llm-response" || call.provider === "reflection" || !call.usage) continue;
    const at = Number(call.at), minute = Math.floor((at - start) / 60000);
    if (minute >= 0 && minute < values.length) values[minute] += Number(call.usage.total_tokens) || Number(call.usage.prompt_tokens ?? call.usage.input_tokens ?? 0) + Number(call.usage.completion_tokens ?? call.usage.output_tokens ?? 0);
  }
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  $("#token-rate-average").textContent = `平均 ${Math.round(average).toLocaleString()} / 分钟`;
  ctx.clearRect(0, 0, width, height);
  const left = 34, right = 8, top = 9, bottom = 21, plotW = width - left - right, plotH = height - top - bottom, peak = Math.max(1, ...values) * 1.12;
  ctx.font = "10px sans-serif";ctx.fillStyle = "#858585";ctx.strokeStyle = "#3f3f46";ctx.lineWidth = 1;
  for (let line = 0; line <= 2; line++) { const y = top + plotH * line / 2;ctx.beginPath();ctx.moveTo(left, y);ctx.lineTo(width - right, y);ctx.stroke();ctx.fillText(Math.round(peak * (1 - line / 2)).toLocaleString(), 0, y + 3); }
  ctx.strokeStyle = "#3794ff";ctx.lineWidth = 2;ctx.beginPath();
  values.forEach((value, index) => { const smooth = (values[Math.max(0, index - 1)] + value + values[Math.min(values.length - 1, index + 1)]) / 3;const x = left + plotW * index / (values.length - 1), y = top + plotH * (1 - smooth / peak);index ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();ctx.fillStyle = "#858585";ctx.fillText("30 分钟前", left, height - 4);ctx.fillText("现在", width - 34, height - 4);
}

function renderFlow(state) {
  const layers = state.layers || {};
  for (const name of ["strategic", "distribution", "strategy", "action", "tac", "reflection", "memory"]) {
    const layer = layers[name] || {};
    const node = document.querySelector(`.layer-node[data-layer="${name}"]`);
    if (!node) continue;
    const stoppedActive = state.status === "stopped" && ["running", "monitoring"].includes(layer.status);
    node.className = `layer-node ${name}-node status-${stoppedActive ? "idle" : layer.status || "idle"}`;
    node.querySelector(".layer-status").textContent = stoppedActive ? "已停止" : layer.label || "--";
    // Render Distribution only from its own input/output, including while
    // connected to an older worker that copied the strategic mission here.
    const task = state.lastDistributionInput?.context?.taskContinuity?.activeTask || state.lastDistributionInput?.activePlan?.tasks?.[0];
    node.querySelector(".layer-detail").textContent = stoppedActive ? `停止前：${layer.detail || layer.label || "等待中"}` : name === "distribution"
      ? layer.status === "running" ? task?.title ? `正在评估短期任务：${task.title}` : "正在生成短期任务，等待分发结果"
        : layer.status === "error" ? layer.detail || "分发失败"
          : state.lastDistribution?.plan?.tasks?.[0]?.title || "尚无 Distribution 分发结果"
      : layer.detail || "--";
    const duration = Number(layer.durationMs || 0);
    node.querySelector("time").textContent = layer.updatedAt ? `${time(layer.updatedAt)}${duration ? ` · ${(duration / 1000).toFixed(1)}秒` : ""}` : "--";
  }

  const timeline = (state.timeline || []).slice().reverse().slice(0, 80);
  $("#timeline-count").textContent = `${state.timeline?.length || 0} 条记录`;
  $("#axis-timeline").innerHTML = timeline.length ? timeline.map(item => `<div class="axis-item ${esc(item.layer)} ${esc(item.type)}"><span class="axis-line"></span><span class="axis-dot"></span><time>${time(item.at)}</time><div><strong>${esc(item.label)}</strong><p>${esc(item.detail || "")}</p></div></div>`).join("") : `<div class="empty">等待运行事件</div>`;
  renderCallTree(state);

  const usage = state.tokenUsage || {};
  renderTokenRate(state);
  const fallbackFlow = () => {
    const phases = [
      ["起步木料", "挖 8 个木头"], ["工作台与木工具", "工作台落地后制作木棍、木镐"],
      ["石制工具", "挖 6 个石头，制作石斧和石镐"], ["原木与食物", "累计 32 原木、4 块肉，羊毛尽量收集"],
      ["斜向下矿道", "安全斜向下进入地下"], ["地下临时据点", "开辟空间，放工作台并制作熔炉、箱子"],
      ["Y=40 煤层", "水平鱼骨采煤"], ["Y=10 铁层", "水平鱼骨采铁"], ["铁制装备", "先铁镐与盾牌，再铁剑和铁甲"]
    ];
    const inventory = state.environment?.inventory || {}, items = inventory.items || [];
    const count = name => items.filter(item => item?.name?.replace(/^minecraft:/, "") === name).reduce((sum, item) => sum + Number(item.count || 0), 0);
    const tier = (kind, minimum) => {
      const tiers = ["wooden", "stone", "iron", "diamond", "netherite"];
      return items.some(item => {
        const match = item?.name?.replace(/^minecraft:/, "").match(/^(wooden|stone|iron|golden|diamond|netherite)_(.+)$/);
        return match && match[2] === kind && match[1] !== "golden" && tiers.indexOf(match[1]) >= tiers.indexOf(minimum);
      });
    };
    const logs = items.filter(item => /_(log|wood)$/.test(item?.name || "")).reduce((sum, item) => sum + Number(item.count || 0), 0);
    const meat = items.filter(item => /^(raw_)?(beef|porkchop|chicken|mutton|rabbit|cod|salmon)$|^cooked_/.test(item?.name || "")).reduce((sum, item) => sum + Number(item.count || 0), 0);
    const y = Number(state.environment?.status?.pos?.[1]);
    const has = name => count(name) > 0;
    const underground = Number.isFinite(y) && y < 60;
    const nativeState = state.lastDistributionInput?.context?.nativeState;
    const hasBase = (nativeState?.workareas || []).some(area => area.dimension === (state.environment?.status?.dimension || "overworld"));
    const done = [logs >= 8 || has("crafting_table") || tier("pickaxe", "wooden"), tier("pickaxe", "wooden"), tier("pickaxe", "stone") && tier("axe", "stone"), logs >= 32 && meat >= 4 || underground, underground, hasBase, (has("coal") || has("charcoal")) && Number.isFinite(y) && y <= 42 || Number.isFinite(y) && y < 25, tier("pickaxe", "iron"), tier("pickaxe", "iron") && has("shield") && tier("sword", "iron")];
    if (underground) for (let i = 0; i <= 4; i++) done[i] = true;
    const task = state.workQueue?.running?.task || state.lastDistribution?.plan?.tasks?.[0] || {};
    const actionType = state.workQueue?.running?.action?.type || "";
    const taskText = `${task.title || ""} ${task.goal || ""} ${actionType}`;
    let index = done.findIndex(value => !value); if (index < 0) index = phases.length - 1;
    if (/build_workarea|据点|工作区/.test(taskText)) index = 5;
    else if (/fishbone_mine|鱼骨|煤层/.test(taskText)) index = Number.isFinite(y) && y < 25 ? 7 : 6;
    else if (/staircase_down|斜向下|下矿/.test(taskText)) index = 4;
    const evidence = [logs + " 个原木", "木镐等级" + (tier("pickaxe", "wooden") ? "已满足" : "待制作"), "石镐/石斧等级" + (tier("pickaxe", "stone") && tier("axe", "stone") ? "已满足" : "待制作"), logs + "/32 原木、" + meat + "/4 肉；羊毛尽力", Number.isFinite(y) ? "Y=" + y.toFixed(1) : "等待坐标", hasBase ? "已记录地下工作区" : "工作区未确认", "煤 " + count("coal") + "，Y=" + (Number.isFinite(y) ? y.toFixed(1) : "?"), "铁锭 " + count("iron_ingot"), "铁镐/盾牌/铁剑按背包确认"];
    return { currentIndex: index, phases: phases.map(([title, target], i) => ({ title, target, evidence: evidence[i], status: done[i] ? "done" : i === index ? "active" : "upcoming" })) };
  };
  $("#token-prompt-detail").textContent = Number(usage.prompt || 0).toLocaleString();
  $("#token-completion-detail").textContent = Number(usage.completion || 0).toLocaleString();
  $("#token-total-detail").textContent = Number(usage.total || 0).toLocaleString();
  $("#token-requests-detail").textContent = Number(usage.requests || 0).toLocaleString();
  $("#cache-summary").textContent = usage.cacheReportedRequests ? `缓存命中 ${Number(usage.cachedPrompt || 0).toLocaleString()} · 未命中 ${Number(usage.uncachedPrompt || 0).toLocaleString()} · 输入命中率 ${usage.cacheEligiblePrompt ? (100 * usage.cachedPrompt / usage.cacheEligiblePrompt).toFixed(1) : "0.0"}%（仅统计服务返回了缓存字段的请求；Reflection 单列，不计入主合计）` : "服务尚未返回缓存字段，无法确认命中率；Reflection 单列，不计入主合计。";
  $("#token-source").textContent = usage.requests ? `模型 API usage${usage.unreportedRequests ? ` · ${usage.unreportedRequests} 次未提供` : ""}` : "服务未返回 usage";
  $("#token-provider-breakdown").innerHTML = Object.entries(usage.byProvider || {}).map(([name, item]) => `<div class="token-provider-row"><span>${esc(name)}${name === "reflection" ? "（不计入主合计）" : ""}</span><span>${item.unreportedRequests ? "未提供" : `${Number(item.total || 0).toLocaleString()} tokens`} · ${item.requests} 次</span></div>`).join("") || `<div class="empty">尚无分层 Token 数据</div>`;
  const tokenRecords = (state.llmCalls || []).filter(record => record.type === "llm-response").slice().reverse().slice(0, 20);
  $("#token-history").innerHTML = tokenRecords.length ? tokenRecords.map(record => {
    const item = record.usage;
    const total = item ? Number(item.total_tokens || 0) || Number(item.prompt_tokens || item.input_tokens || 0) + Number(item.completion_tokens || item.output_tokens || 0) : null;
    return `<div class="token-row"><span>${esc(record.model || "Strategy LLM")}<small>${time(record.at)}</small></span><strong>${total == null ? "未提供" : `${total.toLocaleString()} tokens`}</strong></div>`;
  }).join("") : `<div class="empty">尚无模型请求记录</div>`;
  const items = state.environment?.inventory?.items || [];
  $("#flow-inventory").innerHTML = `<span class="inventory-title">当前物品栏</span>${items.length ? items.map(item => `<span class="inventory-item">${esc(item.name)} <b>×${esc(item.count)}</b></span>`).join("") : `<span class="empty-inline">暂无物品</span>`}<span class="inventory-spaces">空位 ${state.environment?.inventory?.empty_slots ?? "--"}</span>`;
  const flow = state.earlyFlow || fallbackFlow();
  if (flow?.phases?.length) {
    const current = flow.phases[flow.currentIndex];
    const workingTitle = state.workQueue?.running?.task?.title;
    $("#early-flow-position").textContent = current ? `${workingTitle ? `当前作业：${workingTitle} · 路线记录：` : "路线阶段："}${current.title} · ${current.evidence}` : "等待阶段判断";
    $("#early-flow-track").innerHTML = flow.phases.map((phase, index) => `<article class="early-flow-step ${esc(phase.status)}" aria-current="${phase.status === "active" ? "step" : "false"}"><div class="early-flow-step-head"><b>${phase.status === "done" ? phase.progressSource === "history" ? "记" : "✓" : index + 1}</b><strong>${esc(phase.title)}</strong></div><p>${esc(phase.target)}</p><small>${esc(phase.evidence)}</small></article>`).join("");
  } else {
    $("#early-flow-position").textContent = "等待背包与坐标数据";
    $("#early-flow-track").innerHTML = `<div class="empty">尚无足够环境数据判断流程位置</div>`;
  }
  const hints = state.debugHints || [];
  $("#debug-hints").innerHTML = hints.length ? hints.slice().reverse().map(hint => `<div class="hint-item"><time>${time(hint.at)}</time><span>${esc(hint.text)}</span></div>`).join("") : `<div class="empty">尚无人工提示</div>`;
  const reflection = state.reflection || {};
  $("#reflection-document").textContent = reflection.document || "尚未生成运行总结。";
  $("#reflection-lessons").innerHTML = (reflection.lessons || []).map(lesson => `<div class="lesson-item">${esc(lesson)}</div>`).join("");
}

function renderMemory(state) {
  const archive = state.memoryContext || {
    entries: (state.memoryArchive?.entries || []).filter(item => item.source !== "reflection" && item.kind !== "lesson" && item.kind !== "hint")
      .sort((a, b) => Number(b.importance || 0) - Number(a.importance || 0) || Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0)).slice(0, 24),
    updatedAt: state.memoryArchive?.updatedAt || 0
  };
  const entries = (archive.entries || []).slice().sort((a, b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0));
  $("#memory-count").textContent = entries.length;
  $("#memory-updated").textContent = archive.updatedAt ? `更新 ${time(archive.updatedAt)}` : "尚未更新";
  $("#memory-entries").innerHTML = entries.length ? entries.map(entry => recordCard({ ...entry, at: entry.lastSeenAt }, `${entry.kind || "记忆"} · ${entry.source || "runtime"}`, `<p>${esc(entry.summary || "")}</p><small>出现 ${entry.count || 1} 次 · 重要度 ${Number(entry.importance || 0).toFixed(2)}</small>`, entry.kind === "failure" ? "失败" : "归档")).join("") : `<div class="empty">尚无长期记忆</div>`;
}

function renderCallTree(state) {
  const tools = state.toolCalls || [];
  const queue = state.workQueue || {};
  const front = queue.running || queue.pending?.[0] || null;
  const plans = (state.plans || []).filter(item => Array.isArray(item.plan?.tasks)).slice(-12);
  const legacyApiCalls = new Map();
  let legacyParent = null;
  for (const item of tools.slice().sort((a, b) => Number(a.at || 0) - Number(b.at || 0))) {
    if (item.source?.startsWith("action:") && item.type === "start") legacyParent = item;
    else if (item.source === "C++ 自动化" && legacyParent?.task?.id) {
      const key = `${legacyParent.task.id}:${legacyParent.action?.type}`;
      legacyApiCalls.set(key, [...(legacyApiCalls.get(key) || []), item]);
    } else if (item.source?.startsWith("action:") && ["success", "error"].includes(item.type)) legacyParent = null;
  }
  if (front?.planId) plans.sort((a, b) => Number(b.plan?.planId === front.planId) - Number(a.plan?.planId === front.planId) || Number(b.at || 0) - Number(a.at || 0));
  else plans.reverse();
  const apiLeaf = item => `<li class="call-leaf api-leaf"><span class="call-leaf-title">${esc(item.action?.type || "API")}</span><time>${time(item.at)}</time>${item.type === "error" ? `<b>失败</b>` : `<b>${Number(item.durationMs || 0)} ms</b>`}${item.error?.message ? `<small>${esc(item.error.message)}</small>` : item.action?.params ? `<small>${esc(JSON.stringify(item.action.params).slice(0, 180))}</small>` : ""}</li>`;
  const planNodes = plans.map((entry, planIndex) => {
    const plan = entry.plan, planId = plan.planId;
    const isHeadPlan = front?.planId === planId;
    const actions = plan.tasks.flatMap(task => (task.actions || []).map((action, actionIndex) => {
      const scriptEvents = tools.filter(item => item.planId === planId && (item.taskId === task.id || item.task?.id === task.id) && !item.parentAction && item.action?.type === action.type);
      const apiCalls = tools.filter(item => item.planId === planId && item.taskId === task.id && item.parentAction?.type === action.type);
      if (!apiCalls.length) apiCalls.push(...(legacyApiCalls.get(`${task.id}:${action.type}`) || []));
      const active = queue.running?.planId === planId && queue.running?.task?.id === task.id && queue.running?.action?.type === action.type;
      const queued = (queue.pending || []).some(item => item.planId === planId && item.task?.id === task.id && item.action?.type === action.type);
      const queueHead = front?.planId === planId && front?.task?.id === task.id && front?.action?.type === action.type;
      const result = scriptEvents.slice().reverse().find(item => item.type === "success" || item.type === "error");
      const interrupted = state.status === "stopped" && scriptEvents.some(item => item.type === "start") && !result;
      const status = active ? "队首执行中" : queued ? "队列中" : result?.type === "success" ? "已完成" : result?.type === "error" ? "失败" : interrupted ? "停止前中断" : "待执行";
      const details = [task.title, action.params && JSON.stringify(action.params)].filter(Boolean).join(" · ");
      const progress = scriptEvents.filter(item => item.type === "progress").slice(-2);
      const children = [...apiCalls.slice(-20).map(apiLeaf), ...progress.map(item => `<li class="call-leaf progress-leaf"><span class="call-leaf-title">脚本进度 · ${esc(item.progress?.phase || "运行中")}</span><time>${time(item.at)}</time><small>${esc(JSON.stringify(item.progress || {}).slice(0, 180))}</small></li>`)].join("");
      return `<li class="call-action ${queueHead ? "queue-head-node" : ""}"><details ${queueHead || (planIndex === 0 && actionIndex === 0) ? "open" : ""}><summary><span class="action-state-dot ${active ? "active" : queued ? "queued" : result?.type === "error" ? "failed" : ""}"></span><strong>${esc(action.type)}</strong><small>${esc(status)} · ${esc(task.title)}</small></summary><p>${esc(details)}</p>${children ? `<ul>${children}</ul>` : `<div class="call-placeholder">${esc(status)} · 尚无 API 子调用</div>`}</details></li>`;
    })).join("");
    const shortId = String(planId || "D").replace(/^native-/, "").slice(0, 7);
    const summary = plan.rationale || plan.tasks.map(task => task.title).join("、") || "空计划";
    return `<li class="distribution-node ${isHeadPlan ? "has-queue-head" : ""}"><details ${planIndex === 0 ? "open" : ""}><summary><span class="call-layer-dot distribution"></span><strong>D:${esc(shortId)}</strong><span class="distribution-summary">${esc(summary)}</span><time>${time(entry.at || plan.createdAt)}</time><small>${plan.tasks.length} 个任务</small></summary><ul>${actions || `<li class="call-placeholder">该 Distribution 返回空任务</li>`}</ul></details></li>`;
  }).join("");
  const failures = (state.timeline || []).filter(item => item.layer === "distribution" && item.type === "error").slice(-4).reverse();
  const failureNodes = failures.map(item => `<li class="call-failure"><span class="call-layer-dot tac"></span><strong>Distribution 失败</strong><time>${time(item.at)}</time><small>${esc(item.detail)}</small></li>`).join("");
  $("#call-tree").innerHTML = `<ul class="call-tree-root"><li><details open><summary><strong>Distribution 结果与执行调用</strong><small>${plans.length} 个计划 · 默认展开队首工作</small></summary><ul>${failureNodes}${planNodes || `<li class="call-placeholder">尚无成功的 Distribution 计划</li>`}</ul></details></li></ul>`;
}

function renderQueue(state) {
  const queue = state.workQueue || {}, pending = queue.pending || [];
  const stopped = state.status === "stopped";
  $("#queue-count").textContent = `${stopped ? "停止前快照 · " : queue.paused ? "已暂停 · " : ""}${queue.running ? `${stopped ? "上次运行 1 · " : "执行中 1 · "}` : ""}${stopped ? "此前排队" : "待执行"} ${pending.length}${queue.nextPlan ? " · 下一计划已就绪" : ""}`;
  $("#queue-task").textContent = queue.task?.activeTask ? `${stopped ? "上次任务" : "当前任务"}：${queue.task.activeTask.title}` : queue.running?.task ? `${stopped ? "上次任务" : "当前任务"}：${queue.running.task.title}` : "当前没有执行中的任务";
  const timing = state.timing, seconds = value => Number.isFinite(value) ? `${(value / 1000).toFixed(1)} 秒` : "采样中";
  const timingText = $("#timing-estimate");
  if (timingText) timingText.textContent = timing ? `队列剩余：${seconds(timing.work?.remainingMs)}${timing.work?.stalled ? "（进度停滞，暂停预取）" : ""} · Distribution 均值 ${seconds(timing.generation?.expectedMs)} / P90 ${seconds(timing.generation?.p90Ms)} · 提前量 ${seconds(timing.generation?.leadMs)} · ${timing.queued ? "下一任务已排队" : timing.generating ? "正并行生成下一任务" : "等待预测窗口"} · 分发样本 ${timing.generation?.samples || 0}${timing.lastHandoff ? ` · 上次衔接等待 ${seconds(timing.lastHandoff.gapMs)}` : ""}` : "耗时模型：等待运行数据";
  const card = (item, label) => `<div class="task"><strong>${esc(label)} · ${esc(item.action?.type)}</strong><p>${esc(item.source || "")}${item.startedAt ? ` · 开始 ${time(item.startedAt)}` : item.queuedAt ? ` · 入队 ${time(item.queuedAt)}` : ""}</p><pre class="json-view">${pretty(item.action?.params || {})}</pre></div>`;
  const rows = [...(queue.running ? [card(queue.running, stopped ? "停止前最后动作" : "正在执行")] : []), ...pending.map((item, i) => card(item, `${stopped ? "停止前排队" : "待执行"} ${i + 1}`))];
  for (const [plan, label] of [[queue.nextPlan, "下一任务 · 等待当前任务结束"], [queue.revision, "待应用的任务调整"]]) {
    if (plan) for (const task of plan.tasks || []) rows.push(`<div class="task"><strong>${esc(label)}：${esc(task.title)}</strong><p>${esc(task.goal)}</p><pre class="json-view">${pretty(task.actions || [])}</pre></div>`);
  }
  $("#work-queue").innerHTML = rows.join("") || `<div class="empty">队列为空</div>`;
  const chain = [...(queue.running ? [{ ...queue.running, state: stopped ? "停止前" : "执行中" }] : []), ...pending.map(item => ({ ...item, state: stopped ? "停止前排队" : item.prefetched ? "预测预取 · 待执行" : "待执行" }))];
  $("#queue-chain").innerHTML = chain.length ? chain.map((item, index) => `${index ? `<span class="queue-link" aria-hidden="true">→</span>` : ""}<div class="queue-chip ${index === 0 ? "queue-front" : ""}"><small>${index === 0 ? "队首" : `后续 ${index + 1}`}</small><strong>${esc(item.task?.title || item.action?.type || "脚本")}</strong><span>${esc(item.action?.type || "")}</span><time>${time(item.startedAt || item.queuedAt)}</time><em>${esc(item.state)}</em></div>`).join("") : `<div class="empty">队列为空</div>`;
}

function renderStrategy(state) {
  const output = state.lastDistribution;
  const strategic = state.lastStrategic?.plan;
  $("#strategic-mission").textContent = strategic?.mission || "等待 Strategy 生成长期路线。";
  $("#strategic-age").textContent = strategic ? `Strategy 输出 ${time(state.lastStrategic.at || strategic.createdAt)} · 每4分钟规划` : "尚无战略";
  $("#strategic-objectives").innerHTML = strategic?.objectives?.length ? strategic.objectives.map(item => `<div class="task"><strong>${esc(item.title)} · 优先级 ${esc(item.priority)}</strong><p>${esc(item.goal)}</p>${item.constraints?.length ? `<small>${esc(item.constraints.join("；"))}</small>` : ""}</div>`).join("") : `<div class="empty">长期目标生成后显示</div>`;
  const plan = output?.discarded ? null : output?.plan;
  const execution = state.execution;
  const work = state.autonomousWork;
  const distributing = state.layers?.distribution?.status === "running";
  const task = plan?.tasks?.[0];
  const pending = distributing ? "Distribution 正在生成下一轮任务。\n" : output?.discarded ? `上次方案已作废。原因是${output.discarded}\n` : "";
  $("#rationale").textContent = `${pending}${task ? `${distributing ? "上次分发" : "短期任务"}：${task.title}\n${task.goal || ""}\n` : ""}${plan?.rationale ? `分发依据：${plan.rationale}` : distributing ? "尚无 Distribution 输出。" : "等待 Distribution 分发首个任务。"}${work ? `\n脚本正在运行：${work.phase}，背包目标 ${work.currentCount}/${work.targetCount}；${work.nearEnd ? "接近结束，准备下一轮分发" : "继续自动执行，暂不请求新的分发"}` : ""}`;
  $("#priorities").innerHTML = (plan?.priorities || []).map(priority => `<span class="priority">${esc(priority)}</span>`).join("") || `<span class="empty">暂无优先级</span>`;
  $("#task-count").textContent = `${plan?.tasks?.length || 0} 项`;
  $("#tasks").innerHTML = plan?.tasks?.length ? plan.tasks.map(task => `<div class="task"><strong>${esc(task.title)}</strong><p>${esc(task.goal)}</p><div class="action-chips">${(task.actions || []).map(action => `<span class="action-chip">${esc(action.type)}</span>`).join("")}</div></div>`).join("") : `<div class="empty">计划生成后显示任务</div>`;
  $("#delegation").innerHTML = plan?.delegation?.length ? plan.delegation.map(item => `<div class="delegation-card"><span>${esc(item.role)}：${esc(item.objective)}</span><small>P${esc(item.priority)}</small></div>`).join("") : `<div class="empty">当前计划没有委派任务</div>`;
  $("#plan-age").textContent = plan ? `Distribution ${distributing ? "上次输出" : "输出"} ${time(output.at || plan.createdAt)}${distributing ? " · 新一轮分发中" : execution?.planId === plan.planId ? ` · ${{ running: "执行中", complete: "已完成，等待分发", error: "已停止，等待调整" }[execution.status] || ""}` : " · 待执行"}` : distributing ? "Distribution 分发中 · 尚无输出" : "等待 Distribution";
  $("#strategy-context").textContent = state.lastStrategicInput?.context ? JSON.stringify(state.lastStrategicInput.context, null, 2) : "等待 Strategy 的长期规划输入。";
  $("#distribution-context").textContent = state.lastDistributionInput?.context ? JSON.stringify(state.lastDistributionInput.context, null, 2) : "等待 Distribution 的当前任务输入。";
}

function renderEnvironment(state) {
  const env = state.environment || {};
  const space = env.spatial;
  $("#space-notes").textContent = space ? `${space.legend}；原点 ${space.origin.join(", ")} · ${time(space.observedAt)} · 已确认 ${space.knownCells}/${space.requestedCells} 格。${space.notes.join(" ")}` : "尚无当前位置的可靠空间探测；未知格不能作为可行走证据。";
  $("#space-slices").innerHTML = (space?.slices || []).map(slice => `<div><strong>Y=${esc(slice.y)}</strong><pre>${esc(slice.rows.join("\n"))}</pre></div>`).join("");
  $("#space-directions").innerHTML = (space?.columns || []).map(column => `<div class="data-row"><span>${esc(column.name)} · ${column.walkable ? "可平走" : column.stepUpWalkable ? "可上一级" : column.stairCandidate ? "可最小施工" : "阻挡或未确认"}</span><small>支撑 ${esc(column.support)} / 脚 ${esc(column.feet)} / 头 ${esc(column.head)} / 上余量 ${esc(column.overhead)}</small></div>`).join("");
  const mission = env.mission;
  $("#mission-status").textContent = mission ? mission.ready ? "已准备好，留在主世界" : `尚缺 ${mission.missing.length} 项` : "尚未启用";
  $("#mission-checks").innerHTML = (mission?.checks || []).map(check => `<div class="data-row"><span>${check.ok ? "✓" : "○"} ${esc(check.title)}</span><small>${check.ok ? "已满足" : "待准备"}</small></div>`).join("");
  const entities = env.entities || [];
  $("#entity-count").textContent = `${entities.length} 个`;
  $("#entities").innerHTML = entities.length ? entities.map(entity => `<tr><td>${esc(entity.type)}</td><td>${esc(entity.name)} <small>#${esc(entity.id)}</small></td><td>${entity.dist == null ? "--" : `${number1(entity.dist)} 格`}</td><td>${entity.health == null ? "--" : number1(entity.health)}</td></tr>`).join("") : `<tr><td colspan="4" class="empty">附近没有实体</td></tr>`;
  const blocks = env.blocks?.blocks || {};
  const blockEntries = Array.isArray(blocks) ? blocks.map(block => [block.name, { count: 1, nearest: block.pos }]) : Object.entries(blocks);
  $("#block-scan").textContent = env.blocks?.scanned ? `扫描 ${env.blocks.scanned}` : `${blockEntries.length} 类`;
  $("#blocks").innerHTML = blockEntries.length ? blockEntries.slice(0, 30).map(([name, info]) => `<div class="data-row"><span>${esc(name)}</span><small>${info.count ?? 1} · ${info.nearest ? esc(info.nearest.join(", ")) : ""}</small></div>`).join("") : `<div class="empty">没有可见方块摘要</div>`;
  const items = env.inventory?.items || [];
  $("#empty-slots").textContent = `空位 ${env.inventory?.empty_slots ?? "--"}`;
  $("#inventory").innerHTML = items.length ? items.map(item => `<div class="data-row"><span>${esc(item.name)}</span><small>x${esc(item.count)}</small></div>`).join("") : `<div class="empty">背包数据暂不可用</div>`;
  const bySlot = new Map(items.filter(item => Number.isInteger(Number(item.slot))).map(item => [Number(item.slot), item]));
  $("#inventory-grid").innerHTML = Array.from({ length: 36 }, (_, visualSlot) => {
    const slot = visualSlot < 27 ? visualSlot + 9 : visualSlot - 27;
    const item = bySlot.get(slot);
    const label = item ? String(item.name || "?").replace(/^minecraft:/, "").split("_").map(part => part[0]).join("").slice(0, 3).toUpperCase() : "";
    return `<div class="inventory-cell ${slot < 9 ? "hotbar-cell" : ""} ${item ? "filled" : ""}" title="${item ? `${esc(item.name)} ×${esc(item.count)}` : `空槽位 ${slot}`}" aria-label="${item ? `${esc(item.name)} 数量 ${esc(item.count)}` : `空槽位 ${slot}`}" ><span>${esc(label)}</span>${item ? `<small>${esc(item.count)}</small>` : ""}<i>${slot < 9 ? slot + 1 : slot}</i></div>`;
  }).join("");
  const equipment = [["主手", env.inventory?.held], ["副手", env.inventory?.offhand], ["头盔", env.inventory?.armor?.head], ["胸甲", env.inventory?.armor?.chest], ["护腿", env.inventory?.armor?.legs], ["靴子", env.inventory?.armor?.feet]];
  $("#equipment-slots").innerHTML = equipment.map(([label, item]) => `<div class="equipment-cell ${item ? "filled" : ""}" title="${item ? esc(item.name || item) : `${label}空`}"><small>${label}</small><strong>${item ? esc(typeof item === "string" ? item.replace(/^minecraft:/, "") : item.name || "已装备") : "—"}</strong></div>`).join("");
  const advancements = env.advancements?.advancements || [];
  $("#advancement-count").textContent = advancements.length ? `${advancements.length} 项` : "暂无";
  $("#advancements").innerHTML = advancements.length ? advancements.slice(0, 20).map(item => `<div class="data-row"><span>${esc(item.title || item.id)}</span><small>${esc(item.completed_at || item.status)}</small></div>`).join("") : `<div class="empty">尚未收到进度数据</div>`;
  $("#observation-age").textContent = env.observedAt ? `观测 ${time(env.observedAt)}` : "观测 --";
}

function recordCard(record, title, body, badge = "") {
  return `<article class="record"><div class="record-head"><span class="record-title">${esc(title)}</span><span>${badge ? `<span class="badge ${badge === "失败" ? "error" : badge === "告警" ? "warning" : ""}">${esc(badge)}</span>` : ""} <time>${time(record.at)}</time></span></div>${body}</article>`;
}

function callBody(record) {
  if (showRaw) return record;
  if (record.type === "preflight") return {
    item: record.item,
    requested: record.requested,
    crafts: record.crafts,
    outputPerCraft: record.outputPerCraft,
    ok: record.ok,
    missing: record.missing,
    inventory: record.inventory
  };
  return { action: record.action, progress: record.progress, elapsedMs: record.elapsedMs, durationMs: record.durationMs, queueWaitMs: record.queueWaitMs, result: record.result, error: record.error, queueLength: record.queueLength };
}

function renderCalls(state) {
  const allCalls = state.toolCalls || [];
  const calls = allCalls.slice().reverse();
  $("#calls-count").textContent = state.toolCalls?.length || 0;
  const latest = allCalls.reduce((current, item) => !current || item.at > current.at ? item : current, null);
  if (latest?.type === "start") {
    const elapsed = Math.max(0, Date.now() - latest.startedAt);
    $("#busy").textContent = `${latest.action?.type || "工具调用"} · ${Math.floor(elapsed / 1000)}秒`;
  }
  $("#tool-calls").innerHTML = calls.length ? calls.map(record => recordCard(record, `${record.source || "动作"} · ${record.action?.type || record.item || "未知"}`, `<pre>${pretty(callBody(record))}</pre>`, record.type === "error" ? "失败" : record.type === "preflight" ? (record.ok ? "预检通过" : "预检拒绝") : record.type === "success" ? `完成${record.durationMs ? ` · ${(record.durationMs / 1000).toFixed(1)}秒` : ""}${record.queueWaitMs ? ` · 排队 ${(record.queueWaitMs / 1000).toFixed(1)}秒` : ""}` : record.type === "progress" ? "执行进度" : record.type === "start" ? "执行中" : "")).join("") : `<div class="empty">尚无工具调用</div>`;
  const llm = (state.llmCalls || []).slice().reverse();
  $("#llm-calls").innerHTML = llm.length ? llm.map(record => recordCard(record, `${record.provider || "AI"} · ${record.type}`, `<pre>${pretty(showRaw ? record : { type: record.type, model: record.model, usage: record.usage, request: record.request, content: record.content, error: record.error })}</pre>`, record.type === "llm-error" ? "失败" : "模型")).join("") : "";
}

function renderOthers(state) {
  const outputs = (state.agentOutputs || []).slice().reverse();
  $("#agents-count").textContent = outputs.length;
  $("#agent-outputs").innerHTML = outputs.length ? outputs.map(record => recordCard(record, `${record.agent || "unknown"}${record.taskId ? ` · ${record.taskId}` : ""}`, `<pre>${pretty(record.output)}</pre>`, "输出")).join("") : `<div class="empty">尚无其他 AI 输出</div>`;
}

function renderTac(state) {
  const events = (state.tacEvents || []).slice().reverse();
  $("#tac-count").textContent = events.length;
  $("#tac-events").innerHTML = events.length ? events.map(record => recordCard(record, `Tac · ${record.kind || record.type}`, `<pre>${pretty(record.context || record.data || record.actions)}</pre>`, record.type === "death" ? "失败" : "告警")).join("") : `<div class="empty">尚无 Tac 安全事件</div>`;
}

function render(state) {
  render.lastState = state;
  renderSessionControls(state);
  renderOverview(state); renderFlow(state); renderQueue(state); renderStrategy(state); renderEnvironment(state); renderCalls(state); renderOthers(state); renderTac(state); renderMemory(state);
}

async function poll() {
  try { const response = await fetch("/api/debug/state", { cache: "no-store" }); if (response.ok) render(await response.json()); }
  catch (error) { $("#connection-state").textContent = "调试服务不可用"; }
}
poll(); setInterval(poll, 1000);
