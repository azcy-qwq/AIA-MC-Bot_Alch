import { DebugServer } from "./debug-server.js";
import { RuntimeSupervisor } from "./runtime-supervisor.js";

const supervisor = new RuntimeSupervisor();
const server = new DebugServer({
  store: supervisor,
  host: process.env.DEBUG_UI_HOST || "127.0.0.1",
  port: Number(process.env.DEBUG_UI_PORT || 4173),
  onStart: input => supervisor.start(input),
  onStop: () => supervisor.stop(),
  onRestart: () => supervisor.restart(),
  onNewSession: input => supervisor.newSession(input),
  onHint: input => supervisor.call("hint", { input }),
  onReflection: () => supervisor.call("reflection", {}, 180000),
  onSpace: () => supervisor.call("space", {}, 30000)
});
console.log(`[debug-ui] ${await server.start()}`);
const session = await supervisor.readSession();
if (session?.active && session.deadline > Date.now()) {
  supervisor.start().catch(error => console.error("[agent-start]", error.message));
}
let exiting = false;
async function close() {
  if (exiting) return;
  exiting = true;
  await supervisor.stop(); await server.stop(); process.exit(0);
}
process.once("SIGINT", close); process.once("SIGTERM", close);
