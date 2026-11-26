import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { access } from "node:fs/promises";

export const NATIVE_EXE = fileURLToPath(new URL("../../native/mc-agent-v2.exe", import.meta.url));
const ENDPOINTS = {
  status: ["/status", "GET"], inventory: ["/inventory", "GET"], getBlock: ["/get_block"],
  getEntities: ["/get_entities"], findBlocks: ["/find_blocks"], moveTo: ["/move_to"],
  dig: ["/dig"], place: ["/place"], equip: ["/equip"], craft: ["/craft"],
  windowView: ["/window/view"], windowAct: ["/window/act"], posture: ["/posture"],
  control: ["/control"], look: ["/look"], useItem: ["/use_item"], interact: ["/interact"], drop: ["/drop"]
};
export const errorData = error => ({ code: error?.code || "native_error", message: error?.message || String(error), details: { ...(error?.details || {}), ...(error?.status ? { httpStatus: error.status } : {}) } });
const failure = (code, message, details) => Object.assign(new Error(message), { code, details });

/** Transport only. All world decisions and API parameter construction are native. */
export class NativeBridge {
  constructor({ api, executable = NATIVE_EXE, stateFile = "data/native-state.json", imports = {}, onApi = () => {} }) {
    this.api = api; this.executable = executable; this.stateFile = path.resolve(stateFile); this.imports = imports; this.onApi = onApi;
    this.children = new Set(); this.onExit = () => { for (const child of this.children) child.kill(); };
    process.on("exit", this.onExit);
  }
  async check() { await access(this.executable).catch(() => { throw new Error("C++ 核心尚未编译，请先运行 npm run build-native；不会退回旧脚本"); }); }
  async inventoryBrief(inventory) {
    try { return (await this.run("inventory_brief", { inventory: inventory || {} }).promise).result; }
    catch { return null; }
  }
  async request(method, params, signal) {
    if (method === "observeBlocks") {
      const positions = params.positions;
      if (!Array.isArray(positions) || positions.length > 1024) throw failure("protocol_error", "无效批量观察");
      const values = new Array(positions.length); let index = 0;
      await Promise.all(Array.from({ length: Math.min(8, positions.length) }, async () => {
        while (index < positions.length) { const i = index++; values[i] = (await this.request("getBlock", { pos: positions[i] }, signal)).result; }
      }));
      return { ok: true, result: values };
    }
    const endpoint = ENDPOINTS[method]; if (!endpoint) throw failure("protocol_error", `未授权 API 方法 ${method}`);
    if (signal.aborted) throw failure("cancelled", "已停止该自动化任务");
    const startedAt = Date.now();
    try {
      const response = this.api.request ? await this.api.request(endpoint[0], { method: endpoint[1] || "POST", ...(endpoint[1] === "GET" ? {} : { body: params }), timeoutMs: 0, signal }) : await this.api[method](params);
      if (response?.ok === false) throw failure(response.error?.code, response.error?.message, response.error);
      this.onApi({ method, params, durationMs: Date.now() - startedAt, ok: true }); return response;
    } catch (error) { this.onApi({ method, params, durationMs: Date.now() - startedAt, ok: false, error: errorData(error) }); throw error; }
  }
  run(job, params = {}, { onProgress = () => {} } = {}) {
    const child = spawn(this.executable, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.children.add(child);
    const controller = new AbortController(); const inflight = new Set(); let cancelled = false, outcome, stderr = "", stopping;
    let rejectDone, resolveDone;
    const promise = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    // Attach immediately; the queue may still be waiting for its stop barrier.
    promise.catch(() => {});
    const write = value => { if (!cancelled && !child.stdin.destroyed) child.stdin.write(JSON.stringify(value) + "\n"); };
    child.stdin.on("error", () => {});
    child.stderr.on("data", data => { stderr = (stderr + data).slice(-3000); });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", line => {
      try {
        const data = JSON.parse(line);
        if (data.kind === "progress") { if (!cancelled) onProgress(data.progress); }
        else if (data.kind === "result") outcome = { ok: true, result: data.result, state: data.state };
        else if (data.kind === "error") outcome = { ok: false, error: failure(data.error.code, data.error.message, data.error.details) };
        else if (data.kind === "api") {
          const pending = this.request(data.method, data.params, controller.signal).then(response => write({ id: data.id, ok: true, response }), error => write({ id: data.id, ok: false, error: errorData(error) })).finally(() => inflight.delete(pending));
          inflight.add(pending);
        } else throw failure("protocol_error", "C++ 消息类型错误");
      } catch (error) { outcome = { ok: false, error }; child.kill(); }
    });
    child.on("error", error => { outcome = { ok: false, error }; });
    child.on("close", code => {
      this.children.delete(child); lines.close();
      if (cancelled) rejectDone(failure("cancelled", "任务被高优先级操作中断"));
      else if (outcome?.ok && code === 0) resolveDone(outcome);
      else rejectDone(outcome?.error || failure("native_exit", `C++ 程序退出 ${code} ${stderr}`));
    });
    write({ job, params, stateFile: this.stateFile, imports: this.imports });
    return {
      promise,
      cancel: () => stopping ||= (async () => {
        cancelled = true; child.kill();
        // Cancelling fetch does not stop the server's action. The next job is
        // forbidden until /stop has acknowledged, then outstanding HTTP settles.
        let stopError; try { await this.api.stop(); } catch (error) { stopError = error; }
        controller.abort(); await Promise.allSettled([...inflight]); await promise.catch(() => {});
        if (stopError) throw stopError;
      })()
    };
  }
  monitor(onDecision, onError = () => {}) {
    const child = spawn(this.executable, ["--monitor"], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });this.children.add(child);
    const lines = createInterface({ input: child.stdout }); let pending = false;
    lines.on("line", line => { pending = false; try { onDecision(JSON.parse(line)); } catch (error) { onError(error); } });
    child.on("error", onError); child.stdin.on("error", onError);
    child.on("close", () => { this.children.delete(child); lines.close(); });
    return { send: snapshot => { if (!pending && !child.stdin.destroyed) { pending = true; child.stdin.write(JSON.stringify(snapshot) + "\n"); } }, close: () => child.kill() };
  }
  close() { this.onExit(); process.removeListener("exit", this.onExit); }
}
