import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { MultiBotRuntime } from "../src/multi-bot.js";
import { EventBus } from "../src/core/events.js";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function waitFor(predicate, message) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt > 1000) return reject(new Error(message));
      setTimeout(poll, 1);
    };
    poll();
  });
}

function fakeRuntime() {
  const events = new EventBus();
  const starts = [];
  const gates = new Map();
  let queue = Promise.resolve();
  const runtime = {
    events,
    starts,
    gates,
    executor: {
      snapshot: () => ({ running: starts.length }),
      enqueue(action) {
        const key = action.params.id;
        const gate = deferred();
        gates.set(key, gate);
        const result = queue.then(async () => {
          starts.push(key);
          await gate.promise;
          return { ok: true, botAction: key };
        });
        queue = result.catch(() => {});
        return result;
      }
    },
    async start() { events.emit("started", {}); return { ok: true, status: "online" }; },
    async stop() { events.emit("stopped", {}); return { ok: true, status: "stopped" }; }
  };
  return runtime;
}

test("separate bots run the same skill concurrently with fully isolated state", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "mc-multi-bot-"));
  try {
    const created = [];
    const manager = new MultiBotRuntime({
      config: { api: { baseUrl: "https://default", username: "u", password: "p" }, llm: {}, debug: {}, routes: {}, memory: {}, memoryArchive: {}, distributionState: {}, runtimeState: {}, native: {}, timing: {} },
      bots: [{ id: "alpha", name: "Alpha", url: "https://one", username: "a", password: "1" }, { id: "beta", name: "Beta", url: "https://two", username: "b", password: "2" }],
      stateRoot,
      runtimeFactory: options => { created.push({ config: options.config, runtime: fakeRuntime() }); return created.at(-1).runtime; }
    });
    assert.equal(manager.size, 2);
    assert.equal(created[0].config.api.baseUrl, "https://one");
    assert.equal(created[1].config.api.baseUrl, "https://two");
    const statePaths = [
      config => config.llm.conversationFile,
      config => config.sessionBudget.sessionFile,
      config => config.sessionBudget.ledgerFile,
      config => config.routes.filePath,
      config => config.memory.filePath,
      config => config.memoryArchive.filePath,
      config => config.distributionState.filePath,
      config => config.runtimeState.filePath,
      config => config.progress.filePath,
      config => config.reflection.filePath,
      config => config.native.stateFile,
      config => config.timing.filePath,
      config => config.timing.journalPath
    ];
    for (const getPath of statePaths) assert.notEqual(getPath(created[0].config), getPath(created[1].config));
    const started = await manager.startAll();
    assert.ok(started.every(result => result.status === "fulfilled"));

    const alphaRuntime = created[0].runtime;
    const betaRuntime = created[1].runtime;
    const alphaWork = manager.enqueue("alpha", { type: "fishbone_mine", params: { id: "alpha-work" } });
    const betaWork = manager.enqueue("beta", { type: "fishbone_mine", params: { id: "beta-work" } });
    await waitFor(() => alphaRuntime.starts.length === 1 && betaRuntime.starts.length === 1, "same skill was serialized across bots");
    alphaRuntime.gates.get("alpha-work").resolve();
    betaRuntime.gates.get("beta-work").resolve();
    const outcomes = await Promise.all([alphaWork, betaWork]);
    assert.deepEqual(outcomes.map(result => result.botAction), ["alpha-work", "beta-work"]);

    const first = manager.enqueue("alpha", { type: "fishbone_mine", params: { id: "alpha-first" } });
    const second = manager.enqueue("alpha", { type: "fishbone_mine", params: { id: "alpha-second" } });
    await waitFor(() => alphaRuntime.starts.includes("alpha-first"), "first action did not start");
    assert.equal(alphaRuntime.starts.includes("alpha-second"), false, "one bot must keep its own action queue serial");
    alphaRuntime.gates.get("alpha-first").resolve();
    await waitFor(() => alphaRuntime.starts.includes("alpha-second"), "second action did not follow the first");
    alphaRuntime.gates.get("alpha-second").resolve();
    await Promise.all([first, second]);
    await manager.stopAll();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
