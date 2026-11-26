import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {NativeBridge} from '../src/native/bridge.js';

async function scenario(api,run,saved={}){
  const dir=await mkdtemp(path.join(os.tmpdir(),'mc-tac-protection-'));
  const stateFile=path.join(dir,'state.json');await writeFile(stateFile,JSON.stringify(saved));
  const bridge=new NativeBridge({api,stateFile,executable:process.env.NATIVE_TEST_EXE});
  try{await run(bridge);}finally{bridge.close();await rm(dir,{recursive:true,force:true});}
}
const zombie=(id,pos)=>({id,name:'zombie',type:'hostile',pos});
const snapshot=()=>({status:{alive:true,ready:true,health:824,food:20,pos:[.5,64,.5],on_ground:true},inventory:{items:[],armor:{head:{name:'iron_helmet',slot:5,durability_used:0}}},entities:[zombie(1,[2.5,64,.5])]});
async function decisions(frames){let output;await scenario({},bridge=>new Promise((resolve,reject)=>{output=[];const monitor=bridge.monitor(result=>{output.push(result);if(output.length===frames.length){monitor.close();resolve();}else monitor.send(frames[output.length]);},reject);monitor.send(frames[0]);}));return output;}

test('824 health and continuous healing do not suppress protection against two close mobs',async()=>{
  const s=snapshot();s.status.effects=[{name:'instant_health',level:6}];s.entities.push(zombie(2,[-2,64,.5]));
  const [d]=await decisions([s]);assert.equal(d.kind,'surrounded');assert.ok(d.priority>30);assert.equal(d.params.pressure.closeHostiles,2);
});
test('a single ordinary threat still uses combat when armor is healthy',async()=>{assert.equal((await decisions([snapshot()]))[0].kind,'combat');});
test('only a ready grounded danger-free snapshot explicitly releases a failed protection',async()=>{
  const safe=snapshot();safe.entities=[];safe.status.on_ground=true;
  const air=structuredClone(safe);air.status.on_ground=false;
  const unready=structuredClone(safe);unready.status.ready=false;
  const ds=await decisions([safe,air,unready]);assert.equal(ds[0].safe,true);assert.notEqual(ds[1].safe,true);assert.notEqual(ds[2].safe,true);
});
test('nearby ranged attacker triggers protection beyond melee range when a hurt event identifies it',async()=>{
  const s=snapshot();s.entities=[{id:3,name:'skeleton',type:'hostile',pos:[9,64,.5]}];s.events=[{seq:1,type:'hurt',source_entity:{id:3},damage:2}];assert.equal((await decisions([s]))[0].kind,'ranged_pressure');
});
test('armor wear alone detects sustained attacks even while health remains 824',async()=>{
  const frames=[0,3,6,9].map(used=>{const s=snapshot();s.inventory.armor.head.durability_used=used;return s;});const ds=await decisions(frames);assert.equal(ds.at(-1).kind,'damage_pressure');assert.equal(ds.at(-1).params.pressure.armorWear,9);
});
test('near-breaking armor is protected before health falls',async()=>{const s=snapshot();s.inventory.armor.head.durability_used=136;assert.equal((await decisions([s]))[0].kind,'armor_risk');});
test('damage history remembers confirmed hostile daytime spiders',async()=>{
  const s=snapshot();s.status.is_day=true;s.entities=[{id:7,name:'spider',type:'hostile',pos:[2,64,.5]}];s.events=[{type:'hurt',seq:4,source_entity:{id:7}}];const second=structuredClone(s);second.events=[];const ds=await decisions([s,second]);assert.deepEqual(ds.map(d=>d.kind),['combat','combat']);
});
test('identical hurt events are not counted as repeated attacks',async()=>{
  const s=snapshot();s.events=[{seq:9,type:'hurt',source_entity:{id:1}}];const ds=await decisions([s,s,s,s]);assert.ok(ds.every(d=>d.kind==='combat'));assert.equal(ds.at(-1).params.pressure.recentHits,1);
});
test('large health loss is measured relative to observed maximum, not only ten hearts',async()=>{const a=snapshot(),b=snapshot();b.status.health=300;assert.equal((await decisions([a,b])).at(-1).kind,'low_health');});
test('nearby creeper is an escape condition rather than an invitation to jump at it',async()=>{const s=snapshot();s.entities=[{id:8,name:'creeper',type:'hostile',pos:[3,64,.5]}];assert.equal((await decisions([s]))[0].kind,'creeper');});

function escapeWorld({blocked=false,liquid=false,clearAfter=Infinity,savedBlocks=[],health=824,food=20,hidden=false,extraItems=[],healthAfterRetreat=health}={}){
  let pos=[.5,64,.5],held='iron_sword',queries=0,foodStatusReads=0;const controls=[],postures=[],digs=[],progress=[],foodsUsed=[];
  const blocks=new Map(savedBlocks.map(q=>[JSON.stringify(q),'cobblestone']));
  const status=()=>({alive:true,ready:true,health,food,pos:[...pos],dimension:'overworld',on_ground:true,held:{name:held,slot:36},offhand:{name:'shield',slot:45}});
  const api={async request(url,{body={}}={}){
    let result={};
    if(url==='/status'){
      if(foodsUsed.length&&++foodStatusReads===4)health=14;
      result=status();
    }
    else if(url==='/inventory')result={items:[{name:'iron_sword',count:1,slot:36},{name:'stone_pickaxe',count:1,slot:37},...extraItems],offhand:{name:'shield',slot:45},armor:{head:{name:'iron_helmet',slot:5,durability_used:0}},empty_slots:34};
    else if(url==='/get_entities')result={entities:++queries>clearAfter?[]:[zombie(1,[2.5,64,.5]),zombie(2,[2.5,64,2.5])].map(e=>({...e,visible:!hidden,line_of_sight:!hidden}))};
    else if(url==='/get_block'){const [x,y,z]=body.pos;result={name:blocks.get(JSON.stringify(body.pos))||(liquid&&x===-2&&y===63?'lava':y<64?'stone':blocked&&(Math.abs(x)>1||Math.abs(z)>1)&&y<66?'stone':'air')};}
    else if(url==='/posture'){postures.push(body);result={};}
    else if(url==='/look')result={};
    else if(url==='/equip'){held=body.item;result={};}
    else if(url==='/use_item'){
      assert.equal(body.item,'rotten_flesh');
      foodsUsed.push(body.item);food=20;result={used:true};
    }
    else if(url==='/dig'){digs.push(body.pos);blocks.set(JSON.stringify(body.pos),'air');result={};}
    else if(url==='/control'){assert.equal(body.hit,undefined,'escape must not fight a crowd');controls.push(body);pos[0]-=Math.sin(body.yaw)*5.6*body.ms/1000;pos[2]-=Math.cos(body.yaw)*5.6*body.ms/1000;health=healthAfterRetreat;result={pos:[...pos]};}
    else throw new Error('unexpected protection API '+url);
    return {ok:true,result};
  }};
  return {api,controls,postures,digs,progress,foodsUsed,get pos(){return pos;}};
}
test('combat hands a crowd to native protection and sprints out without another model or attack',async()=>{
  const w=escapeWorld();await scenario(w.api,async b=>{const out=await b.run('jump_attack',{entity_id:1},{onProgress:p=>w.progress.push(p)}).promise;assert.equal(out.result.protected,true);assert.ok(w.controls.length);assert.ok(w.controls.every(c=>c.sprint&&c.stop_on[0]==='death'));assert.ok(w.postures.some(p=>p.shield));assert.equal(out.state.combat.protection.active,false);assert.ok(w.progress.some(p=>p.phase==='combat_protection_handoff'));});
});
test('low-health protection keeps control with Tac until health recovers when hostiles are gone',async()=>{
  const w=escapeWorld({health:4.3,food:17,clearAfter:0,extraItems:[{name:'rotten_flesh',count:1}]});
  await scenario(w.api,async b=>{
    const out=await b.run('survive',{kind:'low_health'},{onProgress:p=>w.progress.push(p)}).promise;
    assert.deepEqual(w.foodsUsed,['rotten_flesh']);
    assert.equal(out.result.stopReason,'protection_safe');
    assert.equal(out.result.health,14);
    assert.ok(w.progress.some(p=>p.phase==='protection_hold'));
  });
});
test('unavailable healing releases ordinary work and a newly nearby threat reactivates Tac',async()=>{
  const w=escapeWorld({health:4.3,food:17,clearAfter:0});
  let nativeCombat;
  await scenario(w.api,async b=>{
    const out=await b.run('survive',{kind:'low_health'}).promise;
    assert.equal(out.result.stopReason,'regeneration_unavailable');
    assert.equal(out.state.combat.protection.active,false);
    nativeCombat=out.state.combat;
    const work=await b.run('mark_anchor',{name:'resume'}).promise;
    assert.deepEqual(work.state.anchors.resume.pos,[0,64,0]);
  });
  const calm={status:{alive:true,ready:true,health:4.3,food:17,pos:[.5,64,.5],on_ground:true,dimension:'overworld'},nativeCombat};
  const threatened={...calm,entities:[zombie(12,[2.5,64,.5])]};
  const hurt={...calm,status:{...calm.status,health:3.3}};
  const frames=await decisions([calm,threatened,hurt]);
  assert.equal(frames[0].safe,true);
  assert.equal(frames[1].kind,'low_health');
  assert.equal(frames[2].kind,'low_health');
});
test('a checked escape route rejects liquid support instead of running into it',async()=>{
  const w=escapeWorld({liquid:true});await scenario(w.api,async b=>{const out=await b.run('survive',{kind:'surrounded'}).promise;assert.equal(out.result.protected,true);assert.ok(w.controls.length);assert.ok(w.controls.every(c=>Math.abs(c.yaw-Math.PI/2)>.01),'direct west path crosses known lava');});
});
test('relative low health with an attacker executes retreat instead of returning ordinary work',async()=>{
  const w=escapeWorld({health:300,healthAfterRetreat:400});await scenario(w.api,async b=>{const out=await b.run('survive',{kind:'low_health',entity_id:1,pressure:{peakHealth:824}}).promise;assert.equal(out.result.protected,true);assert.ok(w.controls.length);assert.ok(w.postures.some(p=>p.shield));});
});
test('combat at critical absolute health hands the attacker to protection without attacking',async()=>{
  const w=escapeWorld({health:6,healthAfterRetreat:14});await scenario(w.api,async b=>{const out=await b.run('jump_attack',{entity_id:1}).promise;assert.equal(out.result.protected,true);assert.ok(w.controls.length);});
});
test('hidden nearby enemies keep protection active rather than reopening a shelter immediately',async()=>{
  const w=escapeWorld({blocked:true,clearAfter:2,hidden:true});await scenario(w.api,async b=>{const out=await b.run('survive',{kind:'surrounded'},{onProgress:p=>w.progress.push(p)}).promise;assert.equal(out.result.protected,true);assert.ok(w.progress.some(p=>p.phase==='protection_hold'));assert.equal(w.controls.length,0);});
});
test('no route and no blocks keeps protection active until the threat leaves, without resuming work or error',async()=>{
  const w=escapeWorld({blocked:true,clearAfter:2});await scenario(w.api,async b=>{const out=await b.run('survive',{kind:'surrounded'},{onProgress:p=>w.progress.push(p)}).promise;assert.equal(out.result.protected,true);assert.equal(w.controls.length,0);assert.ok(w.progress.some(p=>p.phase==='protection_hold'));assert.ok(w.postures.some(p=>p.shield));});
});
test('interrupted protection remembers its own shelter and reopens both doorway blocks only',async()=>{
  const blocks=[[1,64,0],[1,65,0],[-1,64,0],[-1,65,0],[0,66,0]],w=escapeWorld({savedBlocks:blocks,clearAfter:0});
  await scenario(w.api,async b=>{const out=await b.run('survive',{kind:'surrounded'}).promise;assert.equal(out.result.protected,true);assert.deepEqual(w.digs,[[1,64,0],[1,65,0]]);},{combat:{protection:{active:true,dimension:'overworld',blocks}}});
});
