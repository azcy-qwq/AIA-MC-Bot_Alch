import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const load = async file => JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
const configFile = new URL("../data/progress-notify.json", import.meta.url);
const stateFile = new URL("../data/progress-notify-state.json", import.meta.url);
// Only borrow SI's concise, conversational voice; progress stays deterministic and factual.
const cleanText = (value, limit = 100) => String(value ?? "")
  .replace(/(?:Bearer\s+|sk-)[A-Za-z0-9_.-]+/gi, "[已隐藏]")
  .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s,;，；]+/gi, "$1[已隐藏]")
  .replace(/https?:\/\/\S+/gi, "[链接]")
  .replace(/\s+/g, " ").trim().slice(0, limit);

function problemText(error) {
  const text = String(typeof error === "string" ? error : error?.message || "");
  if (/network|fetch|ECONN|socket|网络|连接/i.test(text)) return "接口连接出了问题";
  if (/material|ingredient|材料|原料/i.test(text)) return "材料条件还没满足";
  if (/path|route|寻路|路径/i.test(text)) return "路线暂时受阻";
  if (/place|placement|放置/i.test(text)) return "方块放置受阻";
  if (/craft|合成/i.test(text)) return "合成还没成功";
  if (/smelt|furnace|熔|炉/i.test(text)) return "熔炉交互出了问题";
  return "运行有报错，具体原因还待确认";
}

export function progressMessage(state = {}, { title = "Minecraft 调试进展", note = "" } = {}) {
  state ||= {};
  const environment = state.environment || {}, status = environment.status || {};
  const items = Array.isArray(environment.inventory?.items) ? environment.inventory.items : [];
  const count = name => items.filter(item => item.name?.replace(/^minecraft:/, "") === name)
    .reduce((sum, item) => sum + Math.max(0, Number(item.count) || 0), 0);
  const work = state.workQueue?.running;
  const phase = state.earlyFlow?.phases?.[state.earlyFlow?.currentIndex];
  const observedAt = typeof environment.observedAt === "number" ? environment.observedAt : Date.parse(environment.observedAt);
  const stale = Number.isFinite(observedAt) && Date.now() - observedAt > 60000;
  const task = cleanText(work?.task?.title || work?.title, 65);
  let current;
  if (state.status === "stopped" || state.status === "offline") current = "Agent 已停止";
  else if (state.status === "error") current = "Agent 当前运行异常";
  else if (state.status !== "online") current = "还没确认 Agent 的实时运行状态";
  else if (stale) current = "最新观测已超过一分钟，暂时不能确认角色的实时情况";
  else if (status.alive === false) current = "角色死亡了，恢复进度还要继续确认";
  else if (task) current = `当前工作是「${task}」`;
  else current = "目前没有正在执行的工作";

  const resources = [["diamond", "钻石"], ["obsidian", "黑曜石"], ["iron_ingot", "铁锭"], ["raw_iron", "粗铁"], ["coal", "煤"], ["charcoal", "木炭"]]
    .map(([name, label]) => [count(name), label]).filter(([amount]) => amount > 0)
    .slice(0, 3).map(([amount, label]) => `${amount} 个${label}`);
  const detail = [];
  if (phase?.title) detail.push(`阶段是「${cleanText(phase.title, 45)}」`);
  if (resources.length) detail.push(`${stale || state.status !== "online" ? "上次观测到" : "背包里有"}${resources.join("、")}`);
  const error = state.lastError || (["error", "alert"].includes(state.layers?.action?.status) ? state.layers.action.detail : null);
  if (error) detail.push(`最近记录的问题是${problemText(error)}`);
  if (environment.mission?.ready === true) detail.push("准备清单已经齐了");
  const extra = cleanText(note, 240);
  return [
    `${cleanText(title, 40)} · ${new Date().toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`,
    `管理员，${current}${detail.length ? `；${detail.join("，")}` : ""}`,
    extra
  ].filter(Boolean).join("\n");
}

export async function notifyProgress(state, { force = false, title, note, fetchImpl = fetch } = {}) {
  let config;
  try { config = await load(configFile); } catch (error) { if (error.code === "ENOENT") return { sent: false, reason: "not-configured" };throw error; }
  if (!config.enabled) return { sent: false, reason: "disabled" };
  if (!config.apiKey?.trim()) return { sent: false, reason: "missing-api-key" };
  let previous = {};try { previous = await load(stateFile); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!force && Date.now() - (previous.at || 0) < Math.max(5, Number(config.intervalMinutes) || 30) * 60000) return { sent: false, reason: "interval" };
  if (!config.umo || !config.baseUrl) throw new Error("QQ 通知缺少接收会话或服务地址");
  const message = progressMessage(state, { title, note });
  const response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, "")}/api/v1/im/messages`, {
    method: "POST", headers: { Authorization: `Bearer ${config.apiKey.trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ umo: config.umo, message: [{ type: "plain", text: message }] }), signal: AbortSignal.timeout(15000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.status === "error" || result.ok === false) {
    const detail = String(result.message || result.detail || result.error?.message || "请检查 AstrBot 的 im 权限、适配器在线状态和好友关系").replaceAll(config.apiKey.trim(), "[redacted]").slice(0, 250);
    throw new Error(`QQ 通知未送达（HTTP ${response.status}：${detail}）`);
  }
  await writeFile(stateFile, JSON.stringify({ at: Date.now(), title: title || "Minecraft 调试进展", umo: config.umo }));
  return { sent: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const response = await fetch("http://127.0.0.1:4173/api/debug/state", { signal: AbortSignal.timeout(10000) });
    const state = await response.json();
    const result = await notifyProgress(state, { force: true, title: process.argv.includes("--test") ? "Minecraft 进度通知测试" : "Minecraft 调试进展", note: process.argv.includes("--test") ? "这是你授权的 QQ 通知测试；后续约每 30 分钟汇报，重要问题和最终报告另行发送。" : "" });
    console.log(result.sent ? "QQ 进度消息已提交 AstrBot。" : `未发送：${result.reason}`);
  } catch (error) { console.error(error.message);process.exitCode = 1; }
}
