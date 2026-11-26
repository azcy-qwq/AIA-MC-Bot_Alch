import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HumanTraceStore } from "./human-trace-store.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../ui");
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

export class DebugServer {
  constructor({ store, host = "127.0.0.1", port = 4173, onStart, onStop, onRestart, onNewSession, onHint, onReflection, onSpace, humanTraces = new HumanTraceStore() }) {
    this.store = store;
    this.host = host;
    this.port = port;
    this.onStart = onStart;
    this.onStop = onStop;
    this.onRestart = onRestart;
    this.onNewSession = onNewSession;
    this.onHint = onHint;
    this.onReflection = onReflection;
    this.onSpace = onSpace;
    this.humanTraces = humanTraces;
    this.server = null;
  }

  async start() {
    if (this.server) return this.address();
    this.server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url || "/", `http://${this.host}`);
        if (req.method === "POST" && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return this.json(res, 403, { ok: false, error: "只允许本机调试页面发起控制请求" });
        if (url.pathname.startsWith("/api/traces") && !this.isLocal(req.socket.remoteAddress)) return this.json(res, 403, { ok: false, error: "轨迹接收只允许本机连接" });
        if (req.method === "POST" && url.pathname === "/api/traces") {
          try { return this.json(res, 202, await this.humanTraces.ingest(await this.readJson(req))); }
          catch (error) { return this.json(res, 400, { ok: false, error: error.message }); }
        }
        if (req.method === "GET" && url.pathname === "/api/traces") {
          try { return this.json(res, 200, { events: await this.humanTraces.list({ sessionId: url.searchParams.get("sessionId"), limit: url.searchParams.get("limit") }) }); }
          catch (error) { return this.json(res, 500, { ok: false, error: error.message }); }
        }
        if (req.method === "GET" && url.pathname === "/api/traces/compare") {
          try { return this.json(res, 200, await this.humanTraces.compare({ sessionId: url.searchParams.get("sessionId"), from: url.searchParams.get("from"), to: url.searchParams.get("to") })); }
          catch (error) { return this.json(res, 400, { ok: false, error: error.message }); }
        }
        if (req.method === "POST" && url.pathname === "/api/runtime/session") {
          if (!this.onNewSession) return this.json(res, 503, { ok: false, error: "请更新界面服务后再开启新一轮" });
          try { return this.json(res, 200, await this.onNewSession(await this.readJson(req))); }
          catch (error) { return this.json(res, 400, { ok: false, error: error.message }); }
        }
        if (req.method === "POST" && url.pathname === "/api/runtime/restart") {
          if (!this.onRestart) return this.json(res, 503, { ok: false, error: "自动重启需要新版调试服务" });
          try { return this.json(res, 200, await this.onRestart()); }
          catch (error) { return this.json(res, 500, { ok: false, error: error.message }); }
        }
        if (req.method === "POST" && url.pathname === "/api/debug/space") {
          if (!this.onSpace) return this.json(res, 503, { ok: false, error: "空间探测尚未启用" });
          try { return this.json(res, 200, await this.onSpace()); }
          catch (error) { return this.json(res, 500, { ok: false, error: error.message }); }
        }
        if (req.method === "POST" && url.pathname === "/api/runtime/start") {
          if (!this.onStart) return this.json(res, 503, { error: "Start control is unavailable" });
          try {
            const input = await this.readJson(req);
            const result = await this.onStart(input);
            return this.json(res, 200, result || { ok: true });
          } catch (error) {
            return this.json(res, 400, { ok: false, error: error.message || "Failed to start" });
          }
        }
        if (req.method === "POST" && url.pathname === "/api/runtime/stop") {
          if (!this.onStop) return this.json(res, 503, { error: "Stop control is unavailable" });
          try {
            const result = await this.onStop();
            return this.json(res, 200, result || { ok: true });
          } catch (error) {
            return this.json(res, 500, { ok: false, error: error.message || "Failed to stop" });
          }
        }
        if (req.method === "POST" && url.pathname === "/api/debug/hints") {
          if (!this.onHint) return this.json(res, 503, { ok: false, error: "调试提示当前不可用" });
          try { return this.json(res, 200, await this.onHint(await this.readJson(req))); }
          catch (error) { return this.json(res, 400, { ok: false, error: error.message || "添加提示失败" }); }
        }
        if (req.method === "POST" && url.pathname === "/api/debug/reflection") {
          if (!this.onReflection) return this.json(res, 503, { ok: false, error: "经验总结当前不可用" });
          try { return this.json(res, 200, await this.onReflection()); }
          catch (error) { return this.json(res, 500, { ok: false, error: error.message || "总结失败" }); }
        }
        if (req.method !== "GET") return this.respond(res, 405, "Method Not Allowed", "text/plain");
        if (url.pathname === "/api/debug/state") {
          try { return this.json(res, 200, this.store.snapshot()); }
          catch (error) { return this.json(res, 200, { status: "error", lastError: error.message }); }
        }
        const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const asset = path.resolve(ROOT, requested);
        if (!asset.startsWith(`${ROOT}${path.sep}`)) return this.respond(res, 403, "Forbidden", "text/plain");
        const content = await readFile(asset);
        this.respond(res, 200, content, MIME[path.extname(asset)] || "application/octet-stream");
      } catch (error) {
        this.respond(res, error.code === "ENOENT" ? 404 : 500, "Not Found", "text/plain");
      }
    });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, resolve);
    });
    return this.address();
  }

  address() {
    const address = this.server?.address();
    return typeof address === "object" && address ? `http://${this.host}:${address.port}` : null;
  }

  json(res, status, data) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  }

  isLocal(address = "") {
    return address === "::1" || address === "127.0.0.1" || address === "::ffff:127.0.0.1";
  }

  async readJson(req) {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1_200_000) throw new Error("Request body too large");
    }
    return body ? JSON.parse(body) : {};
  }

  respond(res, status, body, type) {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(body);
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise(resolve => server.close(resolve));
  }
}
