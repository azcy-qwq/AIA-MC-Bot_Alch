import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const empty = () => ({ version: 1, completed: [], updatedAt: 0, resetAt: 0 });

export class ProgressLedger {
  constructor({ filePath = "data/progress-state.json" } = {}) {
    this.filePath = filePath;
    this.state = empty();
    this.saving = Promise.resolve();
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return this;
    this.loaded = true;
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8"));
      this.state = {
        ...empty(),
        ...value,
        completed: [...new Set((value.completed || []).map(Number).filter(Number.isInteger))].sort((a, b) => a - b)
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return this;
  }

  snapshot() { return this.state; }

  async observe(progress, { death = false } = {}) {
    const previous = this.state;
    const next = death ? empty() : { ...this.state, completed: [...this.state.completed] };
    if (death) next.resetAt = Date.now();
    for (const [index, phase] of (progress?.phases || []).entries()) {
      if (phase.status === "done") next.completed.push(index);
    }
    next.completed = [...new Set(next.completed)].sort((a, b) => a - b);
    const changed = death || JSON.stringify(next.completed) !== JSON.stringify(previous.completed) || next.resetAt !== previous.resetAt;
    if (changed) {
      next.updatedAt = Date.now();
      this.state = next;
      await this.persist();
    }
    return this.state;
  }

  persist() {
    this.saving = this.saving.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.tmp`;
      await writeFile(temp, JSON.stringify(this.state, null, 2), "utf8");
      await rename(temp, this.filePath);
    });
    return this.saving;
  }
}

