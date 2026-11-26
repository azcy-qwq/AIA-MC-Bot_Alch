import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {NativeBridge} from '../src/native/bridge.js';

async function scenario(api,run,saved={}){
  const dir=await mkdtemp(path.join(os.tmpdir(),'mc-combat-aim-'));
  const stateFile=path.join(dir,'state.json');await writeFile(stateFile,JSON.stringify(saved));
  const b=new NativeBridge({api,stateFile,executable:process.env.NATIVE_TEST_EXE});
  try{await run(b);}finally{b.close();await rm(dir,{recursive:true,force:true});}
}
function world({name='spider',height=.9,width=1.4,killAfter=1,latency=0,moveOnJump=0,vanishOnJump=false,health=false,wall=false,miss=false,isDay=false}={}){
  let now=0,jumpAt=-10000,pos=[.5,64,.5],target=[2.7,64,.5],yaw=0,pitch=0,held='iron_sword',shield=false,alive=true,landed=true;
  let hits=0,attempts=0;const controls=[],postures=[],samples=[];
  const advance=ms=>{now+=ms;const t=(now-jumpAt)/650;landed=t>=1||t<0;pos=[pos[0],64+(landed?0:4*1.2*t*(1-t)),pos[2]];};
  const boxHit=()=>{
    const origin=[pos[0],pos[1]+1.62,pos[2]],direction=[-Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),-Math.cos(yaw)*Math.cos(pitch)];
    const lo=[target[0]-width/2,target[1],target[2]-width/2],hi=[target[0]+width/2,target[1]+height,target[2]+width/2];let near=0,far=3;
    for(let i=0;i<3;i++){if(Math.abs(direction[i])<1e-8){if(origin[i]<lo[i]||origin[i]>hi[i])return false;continue;}let a=(lo[i]-origin[i])/direction[i],z=(hi[i]-origin[i])/direction[i];if(a>z)[a,z]=[z,a];near=Math.max(near,a);far=Math.min(far,z);if(near>far)return false;}
    return near<=3;
  };
  const status=()=>({pos:[...pos],alive:true,ready:true,dimension:'overworld',health:20,food:20,on_ground:landed,in_water:false,submerged:false,is_day:isDay,held:{name:held,slot:36},offhand:{name:'shield',slot:45},velocity:[0,0,0]});
  const api={async request(url,{body={}}={}){
    advance(latency/2);let result;
    if(url==='/status'){if(!landed)advance(50);result=status();}
    else if(url==='/inventory')result={items:[{name:'iron_sword',count:1,slot:36}],offhand:{name:'shield',count:1,slot:45},empty_slots:34};
    else if(url==='/get_entities')result={entities:alive?[{id:7,name,type:'hostile',pos:[...target],dist:Math.hypot(...target.map((v,i)=>v-pos[i])),...(health?{health:Math.max(0,(killAfter-hits)*6)}:{})}]:[]};
    else if(url==='/get_block')result={name:body.pos[1]<64?'stone':wall&&body.pos[0]===1&&[64,65].includes(body.pos[1])?'stone':'air'};
    else if(url==='/posture'){postures.push(body);shield=body.shield===true;result={};}
    else if(url==='/equip'){assert.equal(body.slot,'hand');held=body.item;result={};}
    else if(url==='/control'){
      controls.push(body);if(controls.length>30)throw new Error('combat fixture detected unbounded swings');
      if(body.yaw!==undefined)yaw=body.yaw;if(body.pitch!==undefined)pitch=body.pitch;
      const selected=[];
      if(body.hit){attempts++;const hit=!miss&&alive&&!shield&&boxHit();samples.push({hit,shield,eye:[pos[0],pos[1]+1.62,pos[2]],target:[...target],yaw,pitch});if(hit){hits++;if(hits>=killAfter)alive=false;}selected.push({entity:hit?{id:7,name}:null,t_ms:0});}
      if(body.jump){jumpAt=now;landed=false;target[0]+=moveOnJump;if(vanishOnJump)alive=false;}
      if(body.forward){pos[0]-=Math.sin(yaw)*body.ms/1000*3.5;pos[2]-=Math.cos(yaw)*body.ms/1000*3.5;}
      advance(body.ms);result={...status(),ms:body.ms,...(body.hit?{hits:selected}:{})};
    }else throw new Error('Unexpected combat API '+url);
    advance(latency/2);return {ok:true,result};
  }};
  return {api,controls,postures,samples,get hits(){return hits;},get attempts(){return attempts;}};
}
for(const [label,options] of [['spider at jump height',{}],['cave spider',{name:'cave_spider',height:.5,width:.7}],['moving spider',{moveOnJump:.4}],['150 ms transport',{latency:150}],['300 ms transport',{latency:300}],['ordinary zombie',{name:'zombie',height:1.95,width:.6}]])test('jump swing aims at current body and selects target: '+label,async()=>{
  const w=world(options);await scenario(w.api,async b=>{
    const out=await b.run('jump_attack',{entity_id:7}).promise;
    assert.equal(w.hits,1);assert.equal(out.result.targetPackets,1);assert.equal(out.result.stopReason,'target_left_view');
    assert.equal(out.result.damageConfirmed,0);assert.equal(out.result.killed,undefined);
    assert.ok(w.controls.some(c=>c.jump));const hit=w.controls.find(c=>c.hit);assert.ok(Number.isFinite(hit.pitch)&&Number.isFinite(hit.yaw));
    assert.ok(w.samples.every(x=>!x.shield));assert.ok(w.controls.every(c=>Array.isArray(c.stop_on)&&!c.stop_on.length));
    assert.equal(out.state.combat.lastStrike.targetPacket,true);assert.deepEqual(w.postures.at(-1),{});
  });
});
test('missing health does not stop a three-hit target as two unconfirmed misses',async()=>{
  const w=world({killAfter:3});await scenario(w.api,async b=>{const out=await b.run('jump_attack',{entity_id:7}).promise;assert.equal(w.hits,3);assert.equal(out.result.targetPackets,3);assert.equal(out.result.damageConfirmed,0);});
});
test('reported health decreases count as damage separately from attack packets',async()=>{
  const w=world({killAfter:3,health:true});await scenario(w.api,async b=>{const out=await b.run('jump_attack',{entity_id:7}).promise;assert.equal(out.result.targetPackets,3);assert.equal(out.result.damageConfirmed,2);});
});
test('a disappearing target ends combat without stale entity look errors',async()=>{
  const w=world({vanishOnJump:true});await scenario(w.api,async b=>{const out=await b.run('jump_attack',{entity_id:7}).promise;assert.equal(out.result.stopReason,'target_left_view');assert.equal(w.attempts,0);});
});
test('a real wall prevents swinging through the wall and records unchanged geometry',async()=>{
  const w=world({wall:true});await scenario(w.api,async b=>{const out=await b.run('jump_attack',{entity_id:7}).promise;assert.equal(out.result.stopReason,'sight_blocked');assert.equal(w.attempts,0);assert.ok(out.state.combat.last.targetPos);});
});
test('an air swing is recorded as a miss and never counted as a selected target',async()=>{
  const w=world({miss:true});await scenario(w.api,async b=>{const out=await b.run('jump_attack',{entity_id:7}).promise;assert.equal(out.result.stopReason,'aim_missed');assert.equal(out.result.targetPackets,0);assert.equal(w.attempts,2);});
});
async function monitor(b,snapshot){return new Promise((resolve,reject)=>{const m=b.monitor(result=>{m.close();resolve(result);},reject);m.send(snapshot);});}
test('native Tac ignores passive daytime spiders but permits a confirmed attacker',async()=>{
  await scenario({},async b=>{const snap={status:{alive:true,ready:true,health:20,is_day:true,pos:[.5,64,.5]},entities:[{id:7,name:'spider',type:'hostile',pos:[2.5,64,.5],dist:2}]};assert.equal((await monitor(b,snap)).urgent,false);snap.entities[0].confirmed_attacker=true;assert.equal((await monitor(b,snap)).kind,'combat');});
  const w=world({isDay:true});await scenario(w.api,async b=>{const out=await b.run('jump_attack',{entity_id:7,confirmed_attacker:true}).promise;assert.equal(out.result.targetPackets,1);});
});
test('native Tac chases ranged targets and lets a surrounding pack preempt combat',async()=>{
  await scenario({},async b=>{
    const status={alive:true,ready:true,health:20,pos:[.5,64,.5]};
    const skeleton={id:7,name:'skeleton',type:'hostile',pos:[8.5,64,.5],dist:8};
    const chase=await monitor(b,{status,entities:[skeleton]});
    assert.equal(chase.kind,'combat');
    assert.equal(chase.priority,76);
    const pack=[
      {id:7,name:'zombie',type:'hostile',pos:[2.5,64,.5],dist:2},
      {id:8,name:'zombie',type:'hostile',pos:[-.5,64,.5],dist:1},
      {id:9,name:'skeleton',type:'hostile',pos:[.5,64,3.5],dist:3}
    ];
    const retreat=await monitor(b,{status,entities:pack});
    assert.equal(retreat.kind,'surrounded');
    assert.ok(retreat.priority>chase.priority);
  });
});
test('unchanged wall geometry cannot repeatedly interrupt work, movement rearms Tac',async()=>{
  await scenario({},async b=>{const snap={status:{alive:true,ready:true,health:20,pos:[.5,64,.5]},entities:[{id:7,name:'spider',type:'hostile',pos:[2.5,64,.5],dist:2}],nativeCombat:{last:{entityId:7,stopReason:'sight_blocked',botPos:[.5,64,.5],targetPos:[2.5,64,.5]}}};assert.equal((await monitor(b,snap)).urgent,false);snap.entities[0].pos=[2.5,64,1.5];assert.equal((await monitor(b,snap)).kind,'combat');});
});
