import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export function validateRunSession(input) {
  if (!input || typeof input !== "object") throw new Error("请填写新一轮运行设置");
  const durationHours = Number(input.durationHours);
  if (!Number.isFinite(durationHours) || durationHours < 1 / 60 || durationHours > 168) throw new Error("运行时长应为1分钟至168小时");
  const unlimitedTokens = input.unlimitedTokens === true;
  const inputTokens = Number(input.inputTokens), outputTokens = Number(input.outputTokens);
  if (!unlimitedTokens && ![inputTokens, outputTokens].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("输入、输出Token上限都必须是正整数");
  const planningGoal = typeof input.planningGoal === "string" ? input.planningGoal.trim() : "";
  if (!planningGoal || planningGoal.length > 20000) throw new Error("请填写本轮目标，长度不超过20000字");
  return { durationHours, inputTokens: unlimitedTokens ? null : inputTokens, outputTokens: unlimitedTokens ? null : outputTokens, unlimitedTokens, planningGoal };
}

// Only called with the supervisor lock held and no live worker. Archive the old
// ledger (including unsettled reservations) before committing a new identity.
export async function createRunSession(input, {
  sessionFile = "data/debug-session.json", ledgerFile = "data/llm-session-budget.json",
  archiveDir = "data/sessions", reportDir = "docs", now = Date.now
} = {}) {
  const settings = validateRunSession(input);
  const [previous, ledger] = await Promise.all([readJson(sessionFile), readJson(ledgerFile)]);
  const at = now(), id = randomUUID();
  const startedAt = Math.max(at, (Number(previous?.startedAt) || 0) + 1);
  await Promise.all([mkdir(path.dirname(sessionFile), { recursive: true }), mkdir(archiveDir, { recursive: true }), mkdir(reportDir, { recursive: true })]);
  let archiveFile = null;
  if (previous || ledger) {
    archiveFile = path.join(archiveDir, `${previous?.startedAt || "legacy"}-${id}.json`);
    await writeFile(archiveFile, JSON.stringify({ archivedAt: at, session: previous, ledger }, null, 2), { flag: "wx" });
  }
  const reportFile = path.join(reportDir, `run-${startedAt}.md`);
  const session = {
    version: 4, id, active: true, goal: "custom", startedAt,
    deadline: startedAt + Math.round(settings.durationHours * 3600000),
    planningGoal: settings.planningGoal,
    ...(settings.unlimitedTokens ? {} : { tokenBudget: { input: settings.inputTokens, output: settings.outputTokens } }), reportFile
  };
  const tokenLimitText = settings.unlimitedTokens ? "Token 不限额" : `输入上限${settings.inputTokens}，输出上限${settings.outputTokens}`;
  await writeFile(reportFile, `# Agent运行记录\n\n开始：${new Date(startedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}（北京时间）\n\n本轮目标：\n\n${settings.planningGoal}\n\n时长：${settings.durationHours}小时；${tokenLimitText}。\n\n| 时间（北京时间） | 任务 | 结果 | 最近游戏观测 |\n| --- | --- | --- | --- |\n`, { flag: "wx" });
  const temporary = `${sessionFile}.${id}.tmp`;
  await writeFile(temporary, JSON.stringify(session, null, 2));
  await rename(temporary, sessionFile);
  // SessionBudget keys its ledger by startedAt. The next request starts a fresh
  // ledger; the old file remains intact until then and is also archived above.
  return { session, archiveFile };
}
