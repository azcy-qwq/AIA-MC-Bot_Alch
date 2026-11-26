import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_FILE = "data/launch-config.dpapi";

function protect(input, decrypt = false) {
  if (process.platform !== "win32") throw new Error("自动恢复凭据目前仅支持 Windows 本机加密存储");
  const script = 'Add-Type -AssemblyName System.Security; ' + (decrypt
    ? '[Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String([Console]::In.ReadToEnd()),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))'
    : '[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)))');
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("本机配置加解密超时")); }, 10000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { output += chunk; });
    child.once("error", () => { clearTimeout(timer); reject(new Error("无法调用本机配置加密服务")); });
    child.once("close", code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error("本机配置加解密失败")); });
    child.stdin.end(input);
  });
}

export async function saveLaunchConfig(config, filePath = DEFAULT_FILE) {
  const encrypted = await protect(JSON.stringify(config));
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(`${filePath}.tmp`, encrypted, { encoding: "utf8", mode: 0o600 });
  await copyFile(filePath, `${filePath}.bak`).catch(error => { if (error.code !== "ENOENT") throw error; });
  await rename(`${filePath}.tmp`, filePath);
}

export async function loadLaunchConfig(filePath = DEFAULT_FILE) {
  try { return JSON.parse(await protect(await readFile(filePath, "utf8"), true)); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
