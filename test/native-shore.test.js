import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {NativeBridge} from '../src/native/bridge.js';
import {shoreWorld} from './helpers/shore-world.js';
import {shoreBankWorld} from './helpers/shore-bank-world.js';

async function scenario(w,run,saved={}){
  const dir=await mkdtemp(path.join(os.tmpdir(),'mc-shore-')),stateFile=path.join(dir,'state.json');
  await writeFile(stateFile,JSON.stringify(saved));
  const bridge=new NativeBridge({api:w.api,stateFile,executable:process.env.NATIVE_TEST_EXE});
  try{await run(bridge,()=>readFile(stateFile,'utf8').then(JSON.parse));}finally{bridge.close();await rm(dir,{recursive:true,force:true});}
}
for(const [label,options] of [['already surfaced',{}],['eye breathes while feet still need an ascent',{eyeSubmersion:true}],['well requires vertical ascent in the same column before moving sideways',{eyeSubmersion:true,well:true}],['first submerged',{submerged:true}],['beyond one local scan',{shoreX:16}],['around a solid waterside obstacle',{obstacle:true}]])test('water escape reaches supported dry bank: '+label,async()=>{
  const w=shoreWorld(options);
  await scenario(w,async b=>{
    const out=await b.run('survive',{kind:'water_exit'},{onProgress:p=>w.progress.push(p)}).promise;
    assert.equal(w.water(),false);assert.equal(w.under(),false);assert.equal(w.grounded(),true);
    assert.equal(out.result.survival.onLand,true);assert.equal(out.state.shoreRecovery.active,false);
    assert.ok(out.state.anchors['最近上岸点']);assert.equal(w.postures.at(-1).jump,false);
    assert.ok(w.progress.some(p=>p.phase==='shore_reached'));
    assert.ok(w.controls.every(c=>!c.forward||c.ms<=900));
    if(options.submerged)assert.ok(out.state.breathing.lastRecovery);
    if(options.obstacle)assert.ok(Math.abs(w.pos[2])>1);
  });
});
test('breathable water without a reachable bank cannot count as successful escape',async()=>{
  const w=shoreWorld({enclosed:true});
  await scenario(w,async(b,read)=>{
    await assert.rejects(b.run('survive',{kind:'water_exit'}).promise,e=>e.code==='no_shore_route');
    const state=await read();assert.equal(state.shoreRecovery.active,true);assert.equal(state.shoreRecovery.status,'blocked');
    assert.equal(w.water(),true);assert.equal(w.under(),false);assert.equal(w.postures.at(-1).jump,true);
  });
});
test('a blocked swimming control tries other geometry and never reports a landing',async()=>{
  const w=shoreWorld({stuck:true});
  await scenario(w,async(b,read)=>{
    await assert.rejects(b.run('survive',{kind:'water_exit'}).promise,e=>e.code==='no_shore_route');
    assert.equal((await read()).shoreRecovery.active,true);assert.equal(w.water(),true);
    assert.ok(w.controls.length>1&&w.controls.length<150);
  });
});
test('ordinary work resumes the same resource objective only after landing',async()=>{
  const w=shoreWorld({submerged:true});
  await scenario(w,async b=>{
    const out=await b.run('explore_cave',{caveId:'after-water',targets:[{item:'diamond',count:1}]}).promise;
    assert.equal(out.result.stopReason,'target_reached');assert.equal(w.grounded(),true);
    assert.deepEqual(out.state.caveSurveys['after-water'].entry,[3,63,0]);assert.equal(out.state.shoreRecovery.active,false);
  });
});
test('Tac requests a water exit even with full oxygen at the surface',async()=>{
  const w=shoreWorld();await scenario(w,async b=>{
    const decision=await new Promise((resolve,reject)=>{const monitor=b.monitor(d=>{monitor.close();resolve(d);},reject);monitor.send({status:{alive:true,ready:true,health:20,oxygen:400,in_water:true,submerged:false}});});
    assert.equal(decision.urgent,true);assert.equal(decision.kind,'water_exit');
  });
});

test('a solid bank becomes a two-block-high landing and the bot actually climbs out',async()=>{
  const w=shoreBankWorld();await scenario(w,async b=>{const out=await b.run('survive',{kind:'water_exit'},{onProgress:p=>w.progress.push(p)}).promise;
    assert.equal(out.result.survival.onLand,true);assert.equal(w.grounded(),true);assert.equal(w.water(),false);assert.equal(w.digs.length,2);
    const q=out.state.shoreRecovery.landingExcavation.target;assert.equal(q[1],63);assert.equal(w.block([q[0],62,q[2]]),'stone');assert.deepEqual(w.digs.map(p=>p[1]),[64,63]);
    assert.equal(out.state.shoreRecovery.landingExcavation.complete,true);assert.ok(w.progress.some(p=>p.phase==='shore_landing_excavated'));assert.equal(w.postures.at(-1).jump,false);
  });
});
for(const [label,options]of [['water behind the bank',{leak:'water'}],['lava behind the bank',{leak:'lava'}],['no solid landing floor',{unsupported:true}],['loose roof above the cut',{looseRoof:true}],['no pick for a stone bank',{noTool:true}]])test('bank excavation refuses '+label,async()=>{
  const w=shoreBankWorld(options);await scenario(w,async(b,read)=>{await assert.rejects(b.run('survive',{kind:'water_exit'}).promise,e=>e.code==='no_shore_route');assert.equal(w.digs.length,0);assert.equal((await read()).shoreRecovery.active,true);assert.equal(w.water(),true);});
});
test('protected workarea blocks are preserved when making an emergency landing',async()=>{
  const w=shoreBankWorld();await scenario(w,async b=>{await assert.rejects(b.run('survive',{kind:'water_exit'}).promise,e=>e.code==='no_shore_route');assert.equal(w.digs.length,0);},{workareas:[{dimension:'overworld',min:[-4,63,-4],max:[4,65,4]}]});
});
test('an obstructed upper bank block is exposed from the lower opening before retrying',async()=>{
  const w=shoreBankWorld({hiddenHead:true});await scenario(w,async b=>{const out=await b.run('survive',{kind:'water_exit'}).promise;assert.equal(out.result.survival.onLand,true);assert.equal(w.failed.length,1);assert.deepEqual(w.digs.map(p=>p[1]),[63,64]);});
});
test('an interrupted half-cut landing is finished without digging its head space again',async()=>{
  const target=[1,63,0],w=shoreBankWorld({removed:[[1,64,0]]});await scenario(w,async b=>{const out=await b.run('survive',{kind:'water_exit'}).promise;assert.equal(out.result.survival.onLand,true);assert.deepEqual(w.digs,[target]);assert.deepEqual(out.state.shoreRecovery.landingExcavation.target,target);},{shoreRecovery:{active:true,dimension:'overworld',entry:[.5,62.5,.5],visited:{},landingExcavation:{target,complete:false}}});
});
