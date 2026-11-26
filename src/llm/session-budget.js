import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Reserve before HTTP, across all layers. Unknown/aborted requests retain their
// full reservation because the remote service may already have billed them.
export class SessionBudget {
  constructor({ sessionFile = 'data/debug-session.json', ledgerFile = 'data/llm-session-budget.json', now = Date.now } = {}) {
    Object.assign(this, { sessionFile, ledgerFile, now });
  }
  session() {
    try { return JSON.parse(fs.readFileSync(this.sessionFile, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  read(session) {
    try { const saved = JSON.parse(fs.readFileSync(this.ledgerFile, 'utf8')); if (saved.startedAt === session.startedAt) return saved; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    return { version: 1, startedAt: session.startedAt, deadline: session.deadline, input: 0, output: 0, requests: 0, byLayer: {}, reservations: {} };
  }
  write(ledger) {
    fs.mkdirSync(path.dirname(this.ledgerFile), { recursive: true });
    fs.writeFileSync(this.ledgerFile + '.tmp', JSON.stringify(ledger, null, 2));
    fs.renameSync(this.ledgerFile + '.tmp', this.ledgerFile);
  }
  reserve(layer, messages, outputLimit) {
    const session = this.session(), limits = session?.tokenBudget;
    if (!limits) return null;
    if (!session.active || this.now() >= session.deadline) throw Object.assign(new Error('本轮运行窗口已结束，停止模型请求'), { code: 'llm_budget_exhausted' });
    const ledger = this.read(session);
    // UTF-8 byte count is a conservative bound for these text-only requests.
    const input = Buffer.byteLength(JSON.stringify(messages), 'utf8') + 2048;
    const held = Object.values(ledger.reservations).reduce((n, r) => ({ input: n.input + r.input, output: n.output + r.output }), { input: 0, output: 0 });
    const remainingInput = limits.input - ledger.input - held.input;
    const remainingOutput = limits.output - ledger.output - held.output;
    if (input > remainingInput || outputLimit > remainingOutput) throw Object.assign(new Error('本轮Token预算不足，暂停新模型请求；C++与Tac继续运行'), { code: 'llm_budget_exhausted' });
    const duration = session.deadline - session.startedAt;
    const share = Math.min(1, Math.max(0, (this.now() - session.startedAt) / duration));
    if (ledger.input + held.input + input > limits.input * share + 120000 || ledger.output + held.output + outputLimit > limits.output * share + 24000) throw Object.assign(new Error('模型消耗快于本轮预算，等待额度恢复'), { code: 'llm_budget_paced', retryAfterMs: 30000 });
    const id = randomUUID();
    ledger.reservations[id] = { layer, input, output: outputLimit, at: this.now() };
    ledger.limits = limits; this.write(ledger);
    return { id, startedAt: session.startedAt };
  }
  settle(ticket, usage) {
    if (!ticket || !usage) return;
    const session = this.session(); if (!session || session.startedAt !== ticket.startedAt) return;
    const ledger = this.read(session), reservation = ledger.reservations[ticket.id];
    if (!reservation) return;
    const input = Number(usage.prompt_tokens ?? usage.input_tokens);
    const output = Number(usage.completion_tokens ?? usage.output_tokens);
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) return;
    ledger.input += input; ledger.output += output; ledger.requests++;
    const layer = ledger.byLayer[reservation.layer] ||= { input: 0, output: 0, requests: 0 };
    layer.input += input; layer.output += output; layer.requests++;
    delete ledger.reservations[ticket.id]; ledger.updatedAt = this.now(); this.write(ledger);
  }
}
