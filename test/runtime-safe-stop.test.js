import test from "node:test";
import assert from "node:assert/strict";
import { createRuntime } from "../src/runtime.js";
import { EventBus } from "../src/core/events.js";
import { createEquipmentAudit } from "../src/debug/equipment-audit.js";

function runtimeFixture(api,events=new EventBus()) {
  const runtime=createRuntime({api,eventBus:events,config:{api:{},llm:{},intervals:{},debug:{enabled:false}}});
  for(const owner of [runtime.strategy,runtime.memory,runtime.memoryArchive]) owner.save=async()=>{};
  runtime.distribution.persist=async()=>{};runtime.timing.close=async()=>{};
  return runtime;
}

test("shutdown disconnects before blocked persistence and never waits for model reflection", async()=>{
  const calls=[];let finishSave;const saved=new Promise(resolve=>{finishSave=resolve;});
  const runtime=runtimeFixture({stop:async()=>{calls.push("stop");},disconnect:async()=>{calls.push("disconnect");},logout:async()=>{calls.push("logout");}});
  runtime.reflection.summarize=()=>{throw new Error("shutdown must not call LLM");};
  runtime.strategy.save=()=>{calls.push("persist");return saved;};
  const stopping=runtime.stop();
  try {await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,["stop","disconnect","logout","persist"]);}
  finally {finishSave();await stopping;}
});

test("shutdown reports an unconfirmed disconnect and still closes local resources",async()=>{
  const calls=[],events=new EventBus();events.on("runtime-game-disconnected",()=>calls.push("confirmed"));events.on("runtime-warning",data=>calls.push(data.type));
  const runtime=runtimeFixture({stop:async()=>{},disconnect:async()=>{throw Object.assign(new Error("offline endpoint"),{code:"network_error"});},logout:async()=>{calls.push("logout");}},events);
  runtime.strategy.save=async()=>{calls.push("persist");};
  await assert.rejects(runtime.stop(),/offline endpoint/);
  assert.deepEqual(calls,["shutdown-disconnect","persist"]);
});

test("equipment audit keeps current worn and carried armor, deduplicates slots and records loss",()=>{
  const records=[],audit=createEquipmentAudit(record=>records.push(record));
  const helmet={name:"diamond_helmet",count:1,slot:5,durability_used:256};
  const snapshot={status:{health:824,pos:[1,65,2]},observedAt:123,inventory:{items:[{name:"iron_helmet",count:1,slot:9}],held:{name:"iron_helmet",count:1,slot:9},armor:{head:helmet,chest:null,legs:null,feet:null}}};
  audit(snapshot);audit(structuredClone(snapshot));assert.equal(records.length,1);
  snapshot.inventory.armor.head=null;audit(snapshot);
  assert.equal(records.length,2);assert.equal(records[1].previous.armor.head.name,"diamond_helmet");assert.equal(records[1].equipment.owned.diamond_helmet,undefined);assert.equal(records[1].equipment.owned.iron_helmet,1);
});

test("equipment audit records wear bands without journaling identical observations",()=>{
  const records=[],audit=createEquipmentAudit(record=>records.push(record));
  const snapshot={status:{pos:[1,2,3]},inventory:{items:[],armor:{head:{name:"diamond_helmet",count:1,slot:5,durability_used:31}}}};
  audit(snapshot);snapshot.inventory.armor.head.durability_used=32;audit(snapshot);snapshot.inventory.armor.head.durability_used=33;audit(snapshot);
  assert.equal(records.length,2);assert.equal(records[1].equipment.armor.head.durability_used,32);
});
