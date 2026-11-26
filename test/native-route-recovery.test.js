import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NativeBridge } from "../src/native/bridge.js";

async function scenario(blockAt,run,saved){
  const dir=await mkdtemp(path.join(os.tmpdir(),"mc-route-recovery-"));
  const world={pos:[.5,64,.5],dug:new Set(),digOps:[],moves:[],state:null};
  const key=p=>p.join(",");
  const api={async request(url,{body={}}={}){
    if(url==="/status")return {ok:true,result:{alive:true,ready:true,health:20,pos:world.pos,dimension:"overworld",held:{name:"stone_pickaxe",count:1,slot:36}}};
    if(url==="/inventory")return {ok:true,result:{items:[{name:"stone_pickaxe",count:1,slot:36},{name:"cobblestone",count:64}],empty_slots:30}};
    if(url==="/find_blocks")return {ok:true,result:{blocks:[]}};
    if(url==="/get_block")return {ok:true,result:{name:world.dug.has(key(body.pos))?"air":blockAt(body.pos),diggable:true}};
    if(url==="/dig"){world.dug.add(key(body.pos));world.digOps.push(body);return {ok:true,result:{}};}
    if(url==="/move_to"){world.pos=[body.x,body.y,body.z];world.moves.push(world.pos);return {ok:true,result:{pos:world.pos}};}
    throw new Error(`unexpected ${url}`);
  }};
  const bridge=new NativeBridge({api,stateFile:path.join(dir,"state.json"),executable:process.env.NATIVE_TEST_EXE});
  if(saved)await writeFile(bridge.stateFile,JSON.stringify(saved));
  try{await run(bridge,world);}finally{bridge.close();await rm(dir,{recursive:true,force:true});}
}

test("fishbone walks an existing supported passage without classifying its air as fresh excavation",async()=>{
  const lane={laneId:"walking",dimension:"overworld",origin:[0,64,0],end:[1,64,0],direction:[1,0,0],mainStep:1,length:2,branchEvery:3,branchLength:1,branchHub:3,branchSign:0,branchStep:0,branches:[],phase:"main"};
  await scenario(p=>p[1]<64?"stone":"air",async(bridge,world)=>{
    const out=await bridge.run("fishbone_mine",{laneId:"walking",direction:"x",length:2,branchEvery:3,avoidCaves:true}).promise;
    assert.equal(out.result.stopReason,"lane_complete");assert.equal(world.dug.size,0);
    assert.deepEqual(world.pos,[2.5,64,.5]);assert.equal(world.moves.length,2);
  },{anchors:{},routes:{},workareas:[],fishboneRoutes:{"fishbone:walking":lane}});
});

test("upstairs cavity detection uses the destination height rather than the old horizontal slice",async()=>{
  await scenario(([x,y,z])=>{
    if(x===0&&z===0&&y>=64)return "air";
    if(x===1&&Math.abs(z)===1&&(y===64||y===65))return "air";
    return "stone";
  },async(bridge,world)=>{
    const out=await bridge.run("staircase_up",{direction:"x",steps:1}).promise;
    assert.equal(out.result.direct,false);assert.deepEqual(world.pos,[1.5,65,.5]);
    assert.deepEqual([...world.dug].sort(),["1,65,0","1,66,0","1,67,0"]);
  });
});

test("upstairs turns toward an existing natural step instead of mining blocks for scaffolding",async()=>{
  await scenario(([x,y,z])=>{
    if(x===0&&z===0&&y>=64)return "air";
    if(x===1&&z===0&&y===64)return "air";
    if(x===0&&z===1&&y===64)return "stone";
    if(x===0&&z===1&&y>=65&&y<=67)return "air";
    return "stone";
  },async(bridge,world)=>{
    const out=await bridge.run("staircase_up",{direction:"x",steps:1}).promise;
    assert.equal(out.result.direct,false);
    assert.deepEqual(world.pos,[.5,65,1.5]);
    assert.equal(world.dug.size,0);
  });
});

test("new fishbone skips provisional null lanes when checking a cave-side entry",async()=>{
  await scenario(([x,y,z])=>{
    if(x===0&&z===0&&y>=64)return "air";
    if(x===1&&z===1&&(y===64||y===65))return "air";
    return "stone";
  },async(bridge,world)=>{
    const out=await bridge.run("fishbone_mine",{laneId:"fresh",direction:"x",length:1,avoidCaves:true}).promise;
    assert.equal(out.result.stopReason,"lane_complete");
    assert.equal(out.state.fishboneRoutes["fishbone:fresh"].mainStep,1);
    assert.ok(world.dug.size>0);
    assert.ok(!world.dug.has("1,64,0"));
  },{anchors:{},routes:{},workareas:[],fishboneRoutes:{"fishbone:abandoned":null}});
});

test("downstairs records its verified landing and does not pathfind for ordinary rubble",async()=>{
  await scenario(([x,y,z])=>x===0&&z===0&&y>=64?"air":"stone",async(bridge,world)=>{
    const out=await bridge.run("staircase_down",{direction:"x",steps:1}).promise;
    assert.equal(out.result.direct,false);
    assert.deepEqual(world.pos,[1.5,63,.5]);
    assert.ok(out.state.traversedCells['overworld:[1,63,0]']);
    assert.ok(world.digOps.length>0);
    assert.ok(world.digOps.every(op=>op.collect===false));
  });
});

test("staircase clears a reachable gravel roof top-down and continues the same step",async()=>{
  await scenario(([x,y,z])=>x===0&&z===0&&y>=64?"air":x===1&&z===0&&(y===67||y===68)?"gravel":"stone",async(bridge,world)=>{
    const out=await bridge.run("staircase_up",{direction:"x",steps:1}).promise;
    assert.equal(out.result.direct,false,JSON.stringify(out.result));assert.deepEqual(world.pos,[1.5,65,.5]);
    assert.deepEqual(world.digOps.map(op=>op.pos),[[1,68,0],[1,67,0],[1,66,0],[1,65,0]]);
    assert.equal(world.digOps[0].collect,false);
  });
});

test("staircase handles natural clay without requesting another distribution",async()=>{
  await scenario(([x,y,z])=>x===0&&z===0&&y>=64?"air":x===1&&z===0&&y===67?"clay":"stone",async(bridge,world)=>{
    const out=await bridge.run("staircase_up",{direction:"x",steps:1}).promise;
    assert.equal(out.result.direct,false,JSON.stringify(out.result));assert.deepEqual(world.pos,[1.5,65,.5]);
    assert.ok(world.dug.has("1,67,0"));
  });
});

test("staircase clears the smooth basalt shell encountered at the deep geode",async()=>{
  await scenario(([x,y,z])=>x===0&&z===0&&y>=64?"air":x===1&&z===0?"smooth_basalt":"stone",async(bridge,world)=>{
    const out=await bridge.run("staircase_down",{direction:"x",steps:1}).promise;
    assert.equal(out.result.direct,false);
    assert.deepEqual(world.pos,[1.5,63,.5]);
    assert.ok(world.dug.has("1,63,0"));
  });
});

test("staircase keeps support intact when the gravel column extends beyond reach",async()=>{
  await scenario(([x,y,z])=>x===0&&z===0&&y>=64?"air":x===1&&z===0&&y>=67&&y<=70?"gravel":"stone",async(bridge,world)=>{
    await assert.rejects(bridge.run("staircase_up",{direction:"x",steps:1}).promise,error=>error.code==="falling_block_risk");
    assert.equal(world.dug.size,0);assert.equal(world.moves.length,0);
  });
});

test("staircase does not open gravel with water above its top",async()=>{
  await scenario(([x,y,z])=>x===0&&z===0&&y>=64?"air":x===1&&z===0&&y===68?"gravel":x===1&&z===0&&y===69?"water":"stone",async(bridge,world)=>{
    await assert.rejects(bridge.run("staircase_up",{direction:"x",steps:1}).promise,error=>error.code==="unsafe_excavation");
    assert.equal(world.dug.size,0);
  });
});

test("explicit cave avoidance ends only the affected directions while recorded branches finish",async()=>{
  await scenario(([x,y,z])=>{
    if(y<64)return "stone";
    if(x===0&&z===0)return "air";
    if((x===5&&z===1||x===3&&z===-2)&&(y===64||y===65))return "air";
    return "stone";
  },async(bridge,world)=>{
    const out=await bridge.run("fishbone_mine",{laneId:"boundaries",direction:"x",length:6,branchEvery:2,branchLength:2,avoidCaves:true}).promise;
    const lane=out.state.fishboneRoutes["fishbone:boundaries"];
    assert.equal(out.result.stopReason,"lane_complete");assert.equal(lane.mainStep,4);
    assert.deepEqual(lane.origin,[0,64,0]);assert.deepEqual(lane.end,[4,64,0]);
    assert.deepEqual(lane.mainBlocked.pos,[5,64,0]);
    const blocked=lane.branches.find(b=>b.hub[0]===2&&b.sign===-1);
    assert.deepEqual(blocked.end,[2,64,-1]);assert.equal(blocked.blocked.code,"open_space_ahead");
    assert.ok(world.dug.has("2,64,2"));assert.ok(!world.dug.has("5,64,0"));
    assert.ok([...world.dug].every(k=>[64,65].includes(Number(k.split(",")[1]))));
  });
});

test("resuming branches keeps the saved hub and sign instead of replaying already finished branches",async()=>{
  const lane={laneId:"resume",dimension:"overworld",origin:[0,64,0],end:[2,64,0],direction:[1,0,0],mainStep:2,length:2,mainFinished:true,branchEvery:2,branchLength:1,branchHub:2,branchSign:1,branchStep:0,phase:"branches",branches:[{hub:[2,64,0],end:[2,64,-1],sign:-1,complete:true}]};
  await scenario(([x,y,z])=>y<64?"stone":z===0&&x>=0&&x<=2||x===2&&z===-1?"air":"stone",async(bridge,world)=>{
    const out=await bridge.run("fishbone_mine",{laneId:"resume"}).promise;
    assert.equal(out.result.stopReason,"lane_complete");
    assert.ok(world.dug.has("2,64,1"));assert.ok([...world.dug].every(k=>Number(k.split(",")[2])===1));
    assert.equal(out.state.fishboneRoutes["fishbone:resume"].branches.length,2);
  },{anchors:{},routes:{},workareas:[],fishboneRoutes:{"fishbone:resume":lane}});
});

test("long fishbone opens branches after a recorded 32-cell stretch before extending its trunk",async()=>{
  await scenario(([x,y,z])=>x===0&&z===0&&y>=64?"air":"stone",async(bridge,world)=>{
    const out=await bridge.run("fishbone_mine",{laneId:"stretches",direction:"x",length:34,branchEvery:10,branchLength:1}).promise;
    assert.equal(out.result.stopReason,"lane_complete",JSON.stringify(out.result));
    const dug=[...world.dug];assert.ok(dug.indexOf("10,64,-1")>dug.indexOf("32,64,0"));
    assert.ok(dug.indexOf("30,64,1")<dug.indexOf("33,64,0"));
    assert.ok(dug.every(k=>[64,65].includes(Number(k.split(",")[1]))));
    const lane=out.state.fishboneRoutes["fishbone:stretches"];
    assert.deepEqual(lane.end,[34,64,0]);assert.equal(lane.branches.length,6);
  });
});

test("unfinished stretch branches resume before more trunk excavation",async()=>{
  const lane={laneId:"stretch-resume",dimension:"overworld",origin:[0,64,0],end:[32,64,0],lastPos:[30,64,0],direction:[1,0,0],mainStep:32,length:34,branchEvery:10,branchLength:1,branchHub:30,branchSign:1,branchStep:0,phase:"branches",branches:[{hub:[30,64,0],end:[30,64,-1],sign:-1,complete:true}]};
  await scenario(([x,y,z])=>y>=64&&z===0&&x>=0&&x<=32?"air":"stone",async(bridge,world)=>{
    const out=await bridge.run("fishbone_mine",{laneId:"stretch-resume"}).promise;
    assert.equal(out.result.stopReason,"lane_complete",JSON.stringify(out.result));
    const dug=[...world.dug];assert.ok(dug.indexOf("30,64,1")<dug.indexOf("33,64,0"));
    assert.ok(!dug.includes("30,64,-1"));assert.ok(!dug.includes("10,64,-1"));
    assert.deepEqual(out.state.fishboneRoutes["fishbone:stretch-resume"].origin,[0,64,0]);
  },{anchors:{},routes:{},workareas:[],fishboneRoutes:{"fishbone:stretch-resume":lane}});
});

for(const hazard of ["water","tuff_bricks","gravel"]){
  test(`fishbone records a ${hazard} branch boundary and continues its other branches`,async()=>{
    await scenario(([x,y,z])=>{
      if(x===0&&z===0&&y>=64)return "air";
      if(hazard==="water"&&x===2&&z===-2&&y===65)return "water";
      if(hazard==="tuff_bricks"&&x===2&&z===-1&&y===65)return "tuff_bricks";
      if(hazard==="gravel"&&x===2&&z===-1&&y>=66&&y<=70)return "gravel";
      return "stone";
    },async(bridge,world)=>{
      const out=await bridge.run("fishbone_mine",{laneId:"local-hazard",direction:"x",length:4,branchEvery:2,branchLength:2}).promise;
      assert.equal(out.result.stopReason,"lane_complete",JSON.stringify(out.result));
      const lane=out.state.fishboneRoutes["fishbone:local-hazard"];
      const blocked=lane.branches.find(b=>b.hub[0]===2&&b.sign===-1);
      assert.equal(blocked.complete,true);assert.deepEqual(blocked.end,[2,64,0]);
      assert.equal(blocked.blocked.code,hazard==="water"?"unsafe_excavation":hazard==="tuff_bricks"?"unsafe_navigation":"falling_block_risk");
      assert.ok(!world.dug.has("2,65,-1"));assert.ok(world.dug.has("2,64,2"));
      assert.deepEqual(lane.origin,[0,64,0]);assert.equal(lane.mainStep,4);
      if(hazard==="water")assert.deepEqual(blocked.blocked.details.boundary,[2,65,-2]);
    });
  });
}

test("a liquid boundary ends only the main direction while recorded safe branches still finish",async()=>{
  await scenario(([x,y,z])=>x===0&&z===0&&y>=64?"air":x===4&&z===1&&y===65?"water":"stone",async(bridge,world)=>{
    const out=await bridge.run("fishbone_mine",{laneId:"main-liquid",direction:"x",length:5,branchEvery:2,branchLength:1}).promise;
    assert.equal(out.result.stopReason,"lane_complete");
    const lane=out.state.fishboneRoutes["fishbone:main-liquid"];
    assert.equal(lane.mainStep,3);assert.equal(lane.mainBlocked.code,"unsafe_excavation");
    assert.deepEqual(lane.mainBlocked.details.boundary,[4,65,1]);
    assert.ok(!world.dug.has("4,65,0"));assert.ok(world.dug.has("2,64,1"));assert.ok(world.dug.has("2,64,-1"));
  });
});
