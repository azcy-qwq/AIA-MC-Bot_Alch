import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const MAX_BATCH = 100;
const MAX_WINDOW_MS = 60 * 60 * 1000;
const ACTION_TYPES = new Set(["move", "jump", "sneak", "mine", "place", "attack", "interact", "craft", "use_item", "inventory", "hurt", "death", "pickup", "observation"]);

function cleanEvent(event, sessionId) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("每条轨迹必须是对象");
  const type = String(event.type || "");
  if (!ACTION_TYPES.has(type)) throw new Error(`不支持的轨迹类型：${type || "空"}`);
  const at = Number(event.at);
  if (!Number.isFinite(at) || at < 1) throw new Error("轨迹 at 必须是 Unix 毫秒时间戳");
  const clean = { sessionId, eventId: String(event.eventId || "").slice(0, 100) || null, at, type };
  for (const key of ["action", "target", "result", "position", "dimension", "state", "metadata"]) {
    if (event[key] !== undefined) clean[key] = event[key];
  }
  if (JSON.stringify(clean).length > 12000) throw new Error("单条轨迹不得超过 12 KB");
  return clean;
}

async function readLines(filePath) {
  try { return (await readFile(filePath, "utf8")).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

export class HumanTraceStore {
  constructor({ filePath = "data/human-traces.jsonl", botLogPath = "data/runtime-events.jsonl" } = {}) {
    this.filePath = filePath;
    this.botLogPath = botLogPath;
  }

  async ingest({ sessionId, events } = {}) {
    const session = String(sessionId || "").trim().slice(0, 100);
    if (!session) throw new Error("sessionId 必填");
    if (!Array.isArray(events) || events.length < 1 || events.length > MAX_BATCH) throw new Error(`events 数量必须为 1-${MAX_BATCH}`);
    const records = events.map(event => cleanEvent(event, session));
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, records.map(record => JSON.stringify(record)).join("\n") + "\n", "utf8");
    return { ok: true, accepted: records.length, sessionId: session };
  }

  async compare({ sessionId, from, to } = {}) {
    const end = Number(to || Date.now());
    const start = Number(from || end - 15 * 60 * 1000);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > MAX_WINDOW_MS) throw new Error("对比窗口须为 0 到 60 分钟");
    const [allHuman, allBot] = await Promise.all([readLines(this.filePath), readLines(this.botLogPath)]);
    const human = allHuman.filter(item => item.at >= start && item.at <= end && (!sessionId || item.sessionId === sessionId));
    const bot = allBot.filter(item => item.at >= start && item.at <= end && ["action-start", "action-end", "action-error", "death"].includes(item.type));
    const botStarts = bot.filter(item => item.type === "action-start");
    const botEnds = bot.filter(item => item.type === "action-end" || item.type === "action-error");
    const categories = [...new Set([...human.map(item => item.type), ...botStarts.map(item => item.action?.type).filter(Boolean)])].sort();
    const counts = Object.fromEntries(categories.map(category => [category, {
      player: human.filter(item => item.type === category).length,
      botStarted: botStarts.filter(item => item.action?.type === category || (category === "move" && item.action?.type === "move_to") || (category === "mine" && ["dig", "dig_many", "mine_continuous", "mine_vein"].includes(item.action?.type))).length,
      botSucceeded: botEnds.filter(item => item.type === "action-end" && (item.action?.type === category || (category === "move" && item.action?.type === "move_to") || (category === "mine" && ["dig", "dig_many", "mine_continuous", "mine_vein"].includes(item.action?.type)))).length
    }]));
    const pairs = human.map(playerEvent => {
      const closest = bot.filter(item => Math.abs(item.at - playerEvent.at) <= 5000 && item.type !== "action-start")
        .sort((left, right) => Math.abs(left.at - playerEvent.at) - Math.abs(right.at - playerEvent.at))[0] || null;
      return { player: playerEvent, nearestBotEvent: closest, deltaMs: closest ? closest.at - playerEvent.at : null };
    });
    return { from: start, to: end, sessionId: sessionId || null, humanEvents: human.length, botEvents: bot.length, counts, pairs };
  }

  async list({ sessionId, limit = 200 } = {}) {
    const n = Math.max(1, Math.min(1000, Number(limit) || 200));
    const records = await readLines(this.filePath);
    return records.filter(item => !sessionId || item.sessionId === sessionId).slice(-n);
  }
}
