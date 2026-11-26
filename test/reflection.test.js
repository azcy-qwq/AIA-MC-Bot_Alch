import test from "node:test";
import assert from "node:assert/strict";
import { EventBus } from "../src/core/events.js";
import { ReflectionEngine } from "../src/reflection/reflection-engine.js";
import { OpenAICompatibleProvider } from "../src/llm/provider.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("Reflection layer creates a Chinese lesson document without an LLM", async () => {
  const events = new EventBus();
  const outputs = [];
  events.on("reflection-output", output => outputs.push(output));
  const reflection = new ReflectionEngine({ eventBus: events });
  const result = await reflection.summarize({
    events: [{ type: "error", detail: "path_not_found" }, { type: "success", detail: "dig_many" }],
    hints: [{ text: "不要重复挖普通石头" }],
    currentPlan: { rationale: "收集木头" }
  }, { force: true });
  assert.match(result.document, /经验教训/);
  assert.match(result.document, /不要重复挖普通石头/);
  assert.equal(outputs.length, 1);
});

test("Reflection explains the equip destination format error", async () => {
  const reflection = new ReflectionEngine();
  const result = await reflection.summarize({ events: [{ type: "action-error", action: { type: "equip" }, error: { message: "invalid destination: 33" } }] }, { force: true });
  assert.match(result.document, /equip\.slot/);
  assert.match(result.document, /off-hand/);
});

test("Reflection persists its debug document across restarts without adding it to agent memory",async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"mc-reflection-"));
  try{
    const filePath=path.join(dir,"reflection.json");
    const first=new ReflectionEngine({filePath});
    const saved=await first.summarize({events:[{type:"error",detail:"test failure"}]},{force:true});
    const events=new EventBus(),outputs=[];events.on("reflection-output",v=>outputs.push(v));
    const restored=new ReflectionEngine({filePath,eventBus:events});await restored.load();
    assert.deepEqual(restored.snapshot(),saved);assert.equal(outputs.length,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("Reflection prompt includes compact measured inventory even while a script is still running",async()=>{
  let payload;const provider=new OpenAICompatibleProvider({baseUrl:"https://example.invalid/v1",apiKey:"test",model:"test",fetchImpl:async(_url,options)=>{payload=JSON.parse(options.body);return {ok:true,json:async()=>({choices:[{message:{content:'{"document":"ok","lessons":[],"nextHints":[]}'}}]})};}});
  await provider.createReflection({environment:{observedAt:123,status:{pos:[1,5,2],busy:"dig",health:20},inventory:{items:[{name:"raw_iron",count:4},{name:"raw_iron",count:5}],empty_slots:7},spatial:{large:"not-needed"}}});
  const input=JSON.parse(payload.messages.at(-1).content);
  assert.equal(input.observed.stock.raw_iron,9);assert.equal(input.observed.busy,"dig");assert.equal(input.observed.at,123);
  assert.equal("spatial" in input.observed,false);assert.equal(input.layer,"reflection");
});
