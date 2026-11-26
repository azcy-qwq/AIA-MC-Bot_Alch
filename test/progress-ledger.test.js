import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProgressLedger } from "../src/strategy/progress-ledger.js";

test("progress stays completed through inventory regressions and only death clears it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-progress-"));
  const filePath = path.join(dir, "progress.json");
  try {
    const ledger = await new ProgressLedger({ filePath }).load();
    await ledger.observe({ phases: [{ status: "done" }, { status: "done" }, { status: "active" }] });
    const initial = JSON.parse(await readFile(filePath, "utf8"));

    await ledger.observe({ phases: [{ status: "active" }, { status: "upcoming" }, { status: "active" }] });
    assert.deepEqual(ledger.snapshot().completed, [0, 1]);
    assert.equal(ledger.snapshot().updatedAt, initial.updatedAt, "unchanged snapshots should not rewrite the ledger");

    await ledger.observe({ phases: [{ status: "active" }] }, { death: true });
    assert.deepEqual(ledger.snapshot().completed, []);
    assert.ok(ledger.snapshot().resetAt > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
