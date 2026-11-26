import test from "node:test";
import assert from "node:assert/strict";
import { TacticalSurvivalScript } from "../src/skills/tactical-survival.js";
import { TacController, normalizeTactics } from "../src/tac/tac-controller.js";
import { EventBus } from "../src/core/events.js";

test("Tac shields between attacks against archers but still retreats at low health", async () => {
  for (const health of [20, 6]) {
    const order = [], status = { alive: true, ready: true, health, pos: [0.5, 64, 0.5] };
    const hostile = { id: 1, name: "skeleton", type: "hostile", pos: [2, 64, 0.5], dist: 1.5 };
    const worldModel = { latest: { status, entities: [hostile] }, events: new EventBus() };
    const tac = new TacController({
      api: { status: async () => ({ result: status }) }, worldModel,
      executor: { busy: false, cancelPending() {} },
      pve: { firstStrike: async () => { order.push("attack"); return { killed: false }; } }
    });
    tac.survival.respond = async ({ responses }) => { if (responses.length) order.push(responses); };
    try {
      await tac.tick();
      assert.deepEqual(order, ["attack", health < 10 ? ["shield", "flee", "eat"] : ["shield"]]);
    } finally { tac.stop(); }
  }
});

test("old spacing advice is ignored without movement", async () => {
  assert.deepEqual(normalizeTactics({responses:["spacing","shield"]}).responses,["shield"]);
  let moves=0;
  const script=new TacticalSurvivalScript({api:{status:async()=>({result:{alive:true,ready:true}}),inventory:async()=>({result:{}})},executor:{enqueue:async()=>{moves++;}}});
  await script.respond({responses:["spacing"]});
  assert.equal(moves,0);
});
