import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {NativeBridge} from '../src/native/bridge.js';
import {NativeDistribution} from '../src/native/distribution.js';
import {EventBus} from '../src/core/events.js';

async function scenario(world,run,saved={}){
  const dir=await mkdtemp(path.join(os.tmpdir(),'mc-warning-'));
  const stateFile=path.join(dir,'state.json');await writeFile(stateFile,JSON.stringify(saved));
  const bridge=new NativeBridge({api:world.api,stateFile,executable:process.env.NATIVE_TEST_EXE});
  try{await run(bridge);}finally{bridge.close();await rm(dir,{recursive:true,force:true});}
}
function surface({full=false,busy=false}={}){
  let pos=[.5,64,.5],pending=0,moveRequests=0;const moves=[],queries=[],progress=[];
  const api={async request(url,{body={}}={}){
    if(url==='/status')return {ok:true,result:{pos,alive:true,ready:true,health:20,food:20,dimension:'overworld',busy:pending-->0?'use_item':null}};
    if(url==='/inventory')return {ok:true,result:{items:[{name:'leather',count:1}],empty_slots:full?0:30}};
    if(url==='/get_block'){queries.push(body.pos);return {ok:true,result:{name:body.pos[1]<64?'grass_block':body.pos[1]===64?'leaf_litter':'air'}};}
    if(url==='/find_blocks')return {ok:true,result:{blocks:[]}};
    if(url==='/get_entities')return {ok:true,result:{entities:[]}};
    if(url==='/move_to'){
      moveRequests++;assert.equal(body.range,0);assert.equal(body.y,64,'ground cover must not be a floor at Y65');
      if(busy&&moveRequests===1){pending=2;return {ok:false,error:{code:'busy',message:'running use_item'}};}
      assert.ok(Math.hypot(body.x-pos[0],body.y-pos[1],body.z-pos[2])<=10.01);
      pos=[body.x,body.y,body.z];moves.push([...pos]);return {ok:true,result:{pos}};
    }
    throw new Error('Unexpected API '+url);
  }};
  return {api,moves,queries,progress,get pos(){return pos;},get moveRequests(){return moveRequests;}};
}
test('leaf litter remains walking clearance and never raises a move destination',async()=>{
  const w=surface();await scenario(w,async b=>{const out=await b.run('move_to',{target:[8,64,0]}).promise;assert.equal(out.result.warning,undefined);assert.deepEqual(w.pos,[8.5,64,.5]);assert.equal(w.moves.length,1);});
});
test('a rejected busy request waits for the server lock and then resumes exactly once',async()=>{
  const w=surface({busy:true});await scenario(w,async b=>{const out=await b.run('move_to',{target:[8,64,0]},{onProgress:p=>w.progress.push(p)}).promise;assert.equal(out.result.warning,undefined);assert.equal(w.moveRequests,2);assert.equal(w.moves.length,1);assert.ok(w.progress.some(p=>p.phase==='server_action_released'));});
});
test('a full inventory with space in the target stack does not abandon surface gathering',async()=>{
  const w=surface({full:true});await scenario(w,async b=>{const out=await b.run('gather_resources',{surveyId:'stack-room',maxNodes:1,targets:[{item:'leather',count:2}]}).promise;assert.equal(out.result.warning,false);assert.equal(out.result.stopReason,'node_batch_complete');assert.equal(w.moves.length,1);});
});
test('an invalid old DFS landing is retired locally while survey progress is preserved',async()=>{
  const w=surface(),visited={};for(const [dx,dz]of [[1,0],[-1,0],[0,1],[0,-1]])for(let i=0;i<=8;i++)visited[JSON.stringify([dx*i,64,dz*i])]=1;
  const survey={entry:[0,64,0],dimension:'overworld',nodes:{'[0,64,0]':{pos:[0,64,0],state:'frontier'}},visitedCells:visited,stack:[[-8,64,0],[-1,65,0],[0,64,0]],runs:[],status:'partial'};
  await scenario(w,async b=>{const out=await b.run('gather_resources',{surveyId:'old-plants',maxNodes:1,targets:[{item:'leather',count:2}]},{onProgress:p=>w.progress.push(p)}).promise;assert.equal(out.result.warning,false);assert.ok(w.progress.some(p=>p.phase==='survey_backtrack_repaired'&&p.skipped[1]===65));assert.ok(out.state.resourceSurveys['old-plants'].visitedCells['[0,64,0]']);assert.ok(w.moves.some(p=>p[0]===-7.5));},{resourceSurveys:{'old-plants':survey}});
});
test('maintenance fills empty armor slots with the best carried piece and preserves worn gear',async()=>{
  const worn={name:'diamond_chestplate',count:1,enchantments:[{name:'protection',level:4}]},armor={head:null,chest:worn,legs:null,feet:null};
  let items=[{name:'iron_helmet',count:1},{name:'diamond_helmet',count:1},{name:'iron_chestplate',count:1}];const equipped=[];
  const w={api:{async request(url,{body={}}={}){
    if(url==='/status')return {ok:true,result:{pos:[.5,64,.5],alive:true,ready:true,health:20,food:20,dimension:'overworld'}};
    if(url==='/inventory')return {ok:true,result:{items,armor,empty_slots:36-items.length}};
    if(url==='/equip'){equipped.push(body);const index=items.findIndex(v=>v.name===body.item);armor[body.slot==='torso'?'chest':body.slot]=items.splice(index,1)[0];return {ok:true,result:{}};}
    throw new Error(url);
  }}};
  await scenario(w,async b=>{await b.run('maintain',{}).promise;assert.deepEqual(equipped,[{item:'diamond_helmet',slot:'head'}]);assert.equal(armor.chest,worn);assert.ok(items.some(v=>v.name==='iron_chestplate'));});
});
test('a far chest is approached through medium legs before block queries or transfers',async()=>{
  let pos=[.5,64,.5],stock=8;const moves=[],opens=[],target=[30,64,0];
  const w={api:{async request(url,{body={}}={}){
    if(url==='/status')return {ok:true,result:{pos,alive:true,ready:true,health:20,food:20,dimension:'overworld'}};
    if(url==='/inventory')return {ok:true,result:{items:[{name:'redstone_block',count:stock}],empty_slots:35}};
    if(url==='/get_block'){assert.ok(Math.hypot(body.pos[0]-pos[0],body.pos[2]-pos[2])<=12,'remote chunk queried before approaching');return {ok:true,result:{name:body.pos.join(',')===target.join(',')?'chest':body.pos[1]<64?'stone':'air'}};}
    if(url==='/move_to'){assert.ok(Math.hypot(body.x-pos[0],body.z-pos[2])<=10.01);pos=[body.x,body.y,body.z];moves.push(pos);return {ok:true,result:{pos}};}
    if(url==='/window/view'){assert.ok(Math.hypot(pos[0]-30,pos[2])<4);opens.push(body);return {ok:true,result:{sections:{container:[]}}};}
    if(url==='/window/act'){for(const op of body.ops){assert.equal(op.item,'redstone_block');stock-=op.count;}return {ok:true,result:{}};}
    throw new Error(url);
  }}};
  await scenario(w,async b=>{const out=await b.run('workshop',{mode:'store',target,items:[{item:'redstone_block',count:2}]}).promise;assert.equal(out.result.warning,undefined);assert.equal(stock,6);assert.ok(moves.length>=3);assert.equal(opens.length,1);});
});
test('an explicit stone-material request gathers cobblestone instead of rejecting the task',async()=>{
  let cobble=0;const held={name:'stone_pickaxe',slot:36,count:1};
  const w={api:{async request(url,{body={}}={}){
    if(url==='/status')return {ok:true,result:{pos:[.5,64,.5],alive:true,ready:true,health:20,food:20,dimension:'overworld',held}};
    if(url==='/inventory')return {ok:true,result:{items:[held,{name:'cobblestone',count:cobble}],empty_slots:30}};
    if(url==='/get_block')return {ok:true,result:{name:!cobble&&body.pos.join(',')==='1,64,0'?'stone':body.pos[1]<64?'stone':'air',diggable:true}};
    if(url==='/find_blocks')return {ok:true,result:{blocks:!cobble&&body.types.includes('stone')?[{name:'stone',pos:[1,64,0]}]:[]}};
    if(url==='/dig'){assert.deepEqual(body.pos,[1,64,0]);cobble++;return {ok:true,result:{}};}
    throw new Error(url);
  }}};
  await scenario(w,async b=>{const out=await b.run('mine_vein',{types:['stone','cobblestone'],targetCount:1}).promise;assert.equal(out.result.warning,undefined);assert.equal(cobble,1);});
});

test('an already met mining target is not compacted away by inventory maintenance',async()=>{
  const w={api:{async request(url){if(url==='/status')return {ok:true,result:{pos:[.5,64,.5],alive:true,ready:true,health:20,dimension:'overworld'}};if(url==='/inventory')return {ok:true,result:{items:[{name:'redstone',count:64},{name:'redstone',count:64}],empty_slots:0}};throw new Error('Completed target must not call '+url);}}};
  await scenario(w,async b=>{const out=await b.run('mine_vein',{types:['redstone_ore'],targetCount:16}).promise;assert.equal(out.result.currentCount,128);assert.equal(out.result.mined,0);});
});

test('a prerequisite warning changes exact resumption into repair of the same objective',async()=>{
  const events=new EventBus(),task={id:'surface',title:'继续采集',goal:'补齐附魔材料',actions:[{type:'gather_resources',params:{surveyId:'same-survey'}}]};let context;
  const distribution=new NativeDistribution({eventBus:events,filePath:null,memory:{snapshot:()=>({})},memoryArchive:{contextSnapshot:()=>({})},provider:{createAutomationPlan:async input=>{context=input.context;return {tasks:[{title:'先修复再续原采集',actions:[{type:'maintain',params:{}}]}]};}}});
  events.emit('action-start',{task,action:task.actions[0]});assert.equal(distribution.resumeExact,true);
  events.emit('action-warning',{task,taskId:task.id,action:task.actions[0],warning:{code:'inventory_full'}});assert.equal(distribution.resumeExact,false);
  await distribution.replan({status:{alive:true}},{execution:{}});assert.equal(context.taskContinuity.mode,'repair_and_continue');assert.equal(context.failedTask.goal,task.goal);
});
