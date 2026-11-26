import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRunSession, validateRunSession } from "../src/debug/run-session.js";
import { SessionBudget } from "../src/llm/session-budget.js";

const input = { durationHours: 4, inputTokens: 8000000, outputTokens: 1500000, planningGoal: "制作附魔台，以实际装备为准" };
test("a new run archives usage and reservations before switching identity, without touching memory", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-new-session-"));
  const options = { sessionFile: path.join(dir, "session.json"), ledgerFile: path.join(dir, "ledger.json"), archiveDir: path.join(dir, "sessions"), reportDir: path.join(dir, "docs"), now: () => 2000 };
  const previous = { active: false, startedAt: 1000, deadline: 1900, planningGoal: "旧目标" };
  const ledger = { startedAt: 1000, input: 200, output: 20, reservations: { unknown: { input: 100, output: 10 } } };
  try {
    await writeFile(options.sessionFile, JSON.stringify(previous)); await writeFile(options.ledgerFile, JSON.stringify(ledger));
    await writeFile(path.join(dir, "memory.json"), '{"keep":true}');
    const { session, archiveFile } = await createRunSession(input, options);
    assert.equal(session.active, true); assert.equal(session.startedAt, 2000); assert.equal(session.deadline, 14402000);
    assert.deepEqual(session.tokenBudget, { input: 8000000, output: 1500000 });
    const archived = JSON.parse(await readFile(archiveFile, "utf8"));
    assert.deepEqual(archived.session, previous); assert.deepEqual(archived.ledger, ledger);
    assert.deepEqual(JSON.parse(await readFile(options.ledgerFile, "utf8")), ledger);
    const budget = new SessionBudget(options), fresh = budget.read(budget.session());
    assert.equal(fresh.input, 0); assert.deepEqual(fresh.reservations, {});
    assert.equal(await readFile(path.join(dir, "memory.json"), "utf8"), '{"keep":true}');
    assert.match(await readFile(session.reportFile, "utf8"), /制作附魔台/);
    const second = await createRunSession(input, options);
    assert.equal(second.session.startedAt, 2001); assert.equal((await readdir(options.archiveDir)).length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("invalid settings cannot replace the previous session or archive anything", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-session-invalid-"));
  try {
    const sessionFile = path.join(dir, "session.json"); await writeFile(sessionFile, '{"active":false}');
    await assert.rejects(createRunSession({ ...input, inputTokens: -1 }, { sessionFile }), /正整数/);
    assert.equal(await readFile(sessionFile, "utf8"), '{"active":false}');
    assert.deepEqual(await readdir(dir), ["session.json"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("unlimited-token sessions omit the token budget while retaining the runtime deadline", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-session-unlimited-"));
  const options = { sessionFile: path.join(dir, "session.json"), ledgerFile: path.join(dir, "ledger.json"), archiveDir: path.join(dir, "sessions"), reportDir: path.join(dir, "docs"), now: () => 3000 };
  try {
    const { session } = await createRunSession({ durationHours: 4, unlimitedTokens: true, planningGoal: "持续采矿" }, options);
    assert.equal(session.deadline, 14403000);
    assert.equal(Object.hasOwn(session, "tokenBudget"), false);
    assert.match(await readFile(session.reportFile, "utf8"), /Token 不限额/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const invalid of [{ durationHours: 0 }, { durationHours: Infinity }, { durationHours: 169 }, { inputTokens: 1.5 }, { outputTokens: 0 }, { outputTokens: Number.MAX_SAFE_INTEGER + 1 }, { planningGoal: " " }]) {
  test(`invalid new run setting is rejected: ${Object.keys(invalid)[0]}=${String(Object.values(invalid)[0])}`, () => {
    assert.throws(() => validateRunSession({ ...input, ...invalid }));
  });
}
