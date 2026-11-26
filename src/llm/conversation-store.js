import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export class ConversationStore {
  constructor({ filePath = null, identity, maxTurns = 6, maxChars = 90000 } = {}) {
    this.filePath = filePath; this.identity = createHash("sha256").update(String(identity)).digest("hex");
    this.maxTurns = maxTurns; this.maxChars = maxChars; this.sessions = {}; this.loaded = null; this.saving = Promise.resolve();
  }
  async load() {
    this.loaded ||= (async () => {
      if (!this.filePath) return;
      try { const saved = JSON.parse(await readFile(this.filePath, "utf8")); if (saved.identity === this.identity) this.sessions = saved.sessions || {}; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    })();
    return this.loaded;
  }
  prepare(layer, system, request) {
    let history = this.sessions[layer]?.system === system ? this.sessions[layer].messages : [];
    history = Array.isArray(history) ? history.filter(m => ["user", "assistant"].includes(m.role) && typeof m.content === "string") : [];
    const current = { role: "user", content: JSON.stringify(request) };
    // Rollover is bounded; current context already contains durable memories,
    // mission, live inventory and task progress, so old observations can expire.
    const compacted = history.length >= this.maxTurns * 2 || JSON.stringify(history).length + current.content.length > this.maxChars;
    if (compacted) history = [];
    return { messages: [{ role: "system", content: system }, ...history, current], compacted, retainedTurns: history.length / 2 };
  }
  async commit(layer, system, messages, content) {
    this.sessions[layer] = { system, messages: [...messages.slice(1), { role: "assistant", content }], updatedAt: Date.now() };
    if (!this.filePath) return;
    const payload = JSON.stringify({ version: 1, identity: this.identity, sessions: this.sessions });
    this.saving = this.saving.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.tmp`;
      await writeFile(temp, payload, { encoding: "utf8", mode: 0o600 }); await rename(temp, this.filePath);
    });
    await this.saving;
  }
}
