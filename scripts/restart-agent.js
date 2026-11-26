import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = await Promise.all(entries.map(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : /\.[cm]?js$/.test(entry.name) ? [path.join(directory, entry.name)] : []));
  return result.flat();
}
try {
  const result = await run(process.execPath, ["--test", "--test-timeout=20000"], { cwd: root, windowsHide: true, timeout: 120000, maxBuffer: 2_000_000 });
  process.stdout.write(result.stdout);
  for (const file of (await Promise.all(["src", "ui", "scripts"].map(dir => files(path.join(root, dir))))).flat()) await run(process.execPath, ["--check", file], { cwd: root, windowsHide: true, timeout: 10000 });
  const base = `http://127.0.0.1:${process.env.DEBUG_UI_PORT || 4173}`;
  const before = await (await fetch(`${base}/api/debug/state`, { signal: AbortSignal.timeout(10000) })).json();
  const response = await fetch(`${base}/api/runtime/restart`, { method: "POST", signal: AbortSignal.timeout(180000) });
  const body = await response.json(); if (!response.ok || body.ok === false) throw new Error(body.error || "重启请求失败");
  const after = await (await fetch(`${base}/api/debug/state`, { signal: AbortSignal.timeout(10000) })).json();
  if (!after.supervisor?.workerPid || after.supervisor.workerPid === before.supervisor?.workerPid) throw new Error("未确认工作进程已切换");
  console.log(`Agent 已重启，工作进程 ${after.supervisor.workerPid}，UI 保持在线。`);
} catch (error) { console.error(error.stdout || error.message); process.exitCode = 1; }
