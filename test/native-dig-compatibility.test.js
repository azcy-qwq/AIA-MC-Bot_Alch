import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NativeBridge } from "../src/native/bridge.js";

function fixture({ withChest = true } = {}) {
  let stored = false, removed = false, coal = 0, held = "diamond_pickaxe", digCalls = 0;
  const enchanted = { name:"diamond_pickaxe", count:1, slot:10, enchantments:[{name:"efficiency",level:5}] };
  const plain = { name:"stone_pickaxe", count:1, slot:11 };
  const calls=[];
  const api={async request(url,options={}) {
    const body=options.body||{};calls.push({url,body});
    if(url==="/status")return {ok:true,result:{pos:[0.5,64,0.5],alive:true,ready:true,health:20,food:20,dimension:"overworld",held:held?{name:held}:null,on_ground:true}};
    if(url==="/inventory")return {ok:true,result:{items:[...(!stored?[enchanted]:[]),plain,{name:"coal",count:coal}],empty_slots:30}};
    if(url==="/find_blocks")return {ok:true,result:{blocks:body.types.includes("chest")?(withChest?[{name:"chest",pos:[0,64,2]}]:[]):removed?[]:[{name:"coal_ore",pos:[1,64,0]}]}};
    if(url==="/get_block") {const key=body.pos.join(",");return {ok:true,result:{name:key==="0,64,2"&&withChest?"chest":key==="0,65,2"||key==="1,64,0"&&removed?"air":key==="1,64,0"?"coal_ore":"stone",pos:body.pos,diggable:true}};}
    if(url==="/equip"){held=body.item;return {ok:true,result:{}};}
    if(url==="/dig"){digCalls++;if(!stored)return {ok:false,error:{code:"internal",message:"enchantments is not iterable"}};removed=true;coal++;return {ok:true,result:{}};}
    if(url==="/window/view")return {ok:true,result:{sections:{container:stored?[enchanted]:[]}}};
    if(url==="/window/act"){assert.equal(body.ops[0].enchanted,true);stored=true;held=null;return {ok:true,result:{}};}
    throw new Error(`unexpected request ${url}`);
  }};
  return {api,calls,state:()=>({stored,removed,coal,digCalls})};
}

test("native mining stashes enchanted gear with verified container ops and retries the same dig once", async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),"mc-dig-compat-")),stateFile=path.join(dir,"state.json"),f=fixture(),bridge=new NativeBridge({api:f.api,stateFile});
  try{
    const result=await bridge.run("mine_vein",{types:["coal_ore"],targetCount:1}).promise;
    assert.equal(result.result.currentCount,1);assert.deepEqual(f.state(),{stored:true,removed:true,coal:1,digCalls:2});
    const saved=JSON.parse(await readFile(stateFile,"utf8"));
    assert.deepEqual(saved.anchors["附魔装备暂存箱"].pos,[0,64,2]);
    assert.equal(saved.apiCompatibility.enchantments.status,"using_plain_tool");
    assert.equal(f.calls.some(call=>call.url==="/drop"),false);
    assert.ok(f.calls.filter(call=>call.url==="/equip").every(call=>call.body.slot==="hand"));
  }finally{bridge.close();await rm(dir,{recursive:true,force:true});}
});

test("native compatibility failure preserves equipment and reports a hard API block", async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),"mc-dig-block-")),f=fixture({withChest:false}),bridge=new NativeBridge({api:f.api,stateFile:path.join(dir,"state.json")});
  try{
    await assert.rejects(bridge.run("mine_vein",{types:["coal_ore"],targetCount:1}).promise,error=>error.code==="api_compatibility_unresolved");
    assert.deepEqual(f.state(),{stored:false,removed:false,coal:0,digCalls:1});
    assert.equal(f.calls.some(call=>call.url==="/window/act"||call.url==="/drop"),false);
  }finally{bridge.close();await rm(dir,{recursive:true,force:true});}
});
