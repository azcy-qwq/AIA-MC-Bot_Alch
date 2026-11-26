import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";

const startedAt = Date.now();
const durationMs = 9 * 60 * 60 * 1000;
const reportPath = "docs/local-nine-hour-report-20261116.md";
const samplePath = "data/local-nine-hour-samples.jsonl";
await mkdir("docs", { recursive: true });
await mkdir("data", { recursive: true });
await writeFile(reportPath, `# 本地 Minecraft 九小时连续调试报告\n\n开始时间：${new Date(startedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}\n\n本轮环境：全新本地 Minecraft 1.21.11 世界、API 18900/18901、完整 Agent 4173 与 TAC-only 对照 4174。\n\n## 当前已知问题\n\n- 初始早期流程曾在树冠悬空后把非落脚点交给普通寻路，出现 60 秒 timeout；随后已记录为本轮重点回归项。\n- TAC 改进副本的 40 项专项测试已通过；其“救援失败后暂停门槛”与默认 TAC 存在行为差异，等待真实危险窗口对照后再决定替换。\n\n## 采样\n\n`, { encoding: "utf8" });
await writeFile(samplePath, "", { encoding: "utf8" });

async function state(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/debug/state`);
    return response.ok ? await response.json() : { error: `HTTP ${response.status}` };
  } catch (error) { return { error: error.message }; }
}

function compact(port, snapshot) {
  const env = snapshot?.environment || {};
  const status = env.status || {};
  return {
    at: Date.now(), port, status: snapshot?.status || null, mode: snapshot?.runtimeMode || null,
    worker: snapshot?.supervisor?.workerPid || null, username: status.username || null,
    pos: status.pos || null, health: status.health ?? null, food: status.food ?? null,
    alive: status.alive ?? null, ready: status.ready ?? null, busy: status.busy || null,
    action: snapshot?.layers?.action?.detail || "", tac: snapshot?.layers?.tac?.status || "",
    tacDetail: snapshot?.layers?.tac?.detail || "", toolCalls: snapshot?.toolCalls?.length || 0,
    runtimeEvents: snapshot?.runtimeEvents?.length || 0, lastError: snapshot?.lastError || null
  };
}

async function sample() {
  const rows = [compact(4173, await state(4173)), compact(4174, await state(4174))];
  await appendFile(samplePath, rows.map(row => JSON.stringify(row)).join("\n") + "\n", "utf8");
  return rows;
}

let lastReportAt = 0;
while (Date.now() - startedAt < durationMs) {
  const rows = await sample();
  if (Date.now() - lastReportAt >= 30 * 60 * 1000) {
    lastReportAt = Date.now();
    await appendFile(reportPath, `### ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}\n\n\`\`\`json\n${JSON.stringify(rows, null, 2)}\n\`\`\`\n\n`, "utf8");
  }
  await new Promise(resolve => setTimeout(resolve, 30_000));
}

const finalRows = await sample();
await appendFile(reportPath, `## 九小时窗口结束\n\n结束时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}\n\n\`\`\`json\n${JSON.stringify(finalRows, null, 2)}\n\`\`\`\n`, "utf8");
