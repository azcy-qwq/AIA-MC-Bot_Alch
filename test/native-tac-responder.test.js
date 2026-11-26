import test from 'node:test';
import assert from 'node:assert/strict';
import {EventBus} from '../src/core/events.js';
import {NativeTacResponder} from '../src/tac/native-responder.js';
import {NativeExecutor} from '../src/native/executor.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
  const calls=[],events=new EventBus();let finish;
  const executor={running:{source:'action:gather'},async interrupt(options){calls.push(['interrupt',options.resume]);if(this.running?.source==='tac')finish?.();this.running=null;},priority(action,source){calls.push([action.type,action.params.kind]);this.running={source};return new Promise(resolve=>{finish=result=>{this.running=null;resolve(result);};});},resume(){calls.push(['resume']);}};
  let enabled=true;const responder=new NativeTacResponder({executor,events,canRun:()=>enabled});
  return {calls,executor,responder,events,finish:result=>finish(result),disable:()=>{enabled=false;}};
}
test('higher native danger preempts combat while preserving and resuming the original task once',async()=>{
  const f=fixture(),done=f.responder.submit({urgent:true,kind:'combat',priority:30,params:{kind:'combat'}});await tick();
  f.responder.submit({urgent:true,kind:'combat',priority:30});assert.equal(f.calls.length,2);
  f.responder.submit({urgent:true,kind:'surrounded',priority:75,params:{kind:'surrounded'}});await tick();
  assert.deepEqual(f.calls,[['interrupt',true],['jump_attack','combat'],['interrupt',false],['survive','surrounded']]);assert.equal(f.responder.busy,true);
  f.finish();await done;assert.deepEqual(f.calls.at(-1),['resume']);assert.equal(f.calls.filter(c=>c[0]==='resume').length,1);
});
test('danger arriving during the ordinary task stop barrier replaces combat before it starts',async()=>{
  const f=fixture();let release;f.executor.interrupt=options=>{f.calls.push(['interrupt',options.resume]);return new Promise(resolve=>{release=resolve;});};
  const done=f.responder.submit({urgent:true,kind:'combat',priority:30});
  f.responder.submit({urgent:true,kind:'surrounded',priority:75,params:{kind:'surrounded'}});release();await tick();
  assert.deepEqual(f.calls,[['interrupt',true],['survive','surrounded']]);f.finish();await done;
});
test('shutdown during protection never resumes the ordinary task',async()=>{
  const f=fixture(),done=f.responder.submit({urgent:true,kind:'armor_risk',priority:68,params:{kind:'armor_risk'}});await tick();f.disable();f.finish();await done;assert.equal(f.calls.some(c=>c[0]==='resume'),false);
});
test('death during protection keeps the interrupted ordinary task paused',async()=>{
  const f=fixture();let alive=true;f.responder.isAlive=()=>alive;
  const done=f.responder.submit({urgent:true,kind:'surrounded',priority:75,params:{kind:'surrounded'}});await tick();alive=false;f.finish();await done;assert.equal(f.calls.some(c=>c[0]==='resume'),false);
});
test('a failed rescue cannot resume work until C++ explicitly confirms safe ground',async()=>{
  const f=fixture(),done=f.responder.submit({urgent:true,kind:'drowning',priority:95,params:{kind:'drowning'}});await tick();
  f.finish({error:{code:'survival_priority',message:'air exit not stable'}});await done;
  assert.equal(f.responder.awaitingSafe,true);assert.equal(f.calls.some(c=>c[0]==='resume'),false);
  f.responder.submit({urgent:false});f.responder.submit({urgent:false,safe:false});assert.equal(f.calls.some(c=>c[0]==='resume'),false);
  f.responder.submit({urgent:false,safe:true});f.responder.submit({urgent:false,safe:true});assert.equal(f.calls.filter(c=>c[0]==='resume').length,1);
});
test('after a failed protection, the next same-priority native danger can retry it',async()=>{
  const f=fixture(),danger={urgent:true,kind:'surrounded',priority:75,params:{kind:'surrounded'}};
  const first=f.responder.submit(danger);await tick();f.finish({error:{code:'network_error'}});await first;
  const next=f.responder.submit(danger);await tick();assert.equal(f.calls.filter(c=>c[0]==='survive').length,2);assert.equal(f.calls.some(c=>c[0]==='resume'),false);
  f.finish();await next;assert.equal(f.calls.filter(c=>c[0]==='resume').length,1);
});
test('successful low-health rescue is latched and entity ids never turn protection into an attack',async()=>{
  const f=fixture(),danger={urgent:true,kind:'low_health',priority:80,params:{kind:'low_health',entity_id:42}};
  const first=f.responder.submit(danger);await tick();assert.deepEqual(f.calls[1],['survive','low_health']);f.finish();await first;
  f.responder.submit(danger);assert.equal(f.calls.filter(c=>c[0]==='survive').length,1);
  f.responder.submit({urgent:false,safe:true});
  const second=f.responder.submit(danger);await tick();assert.equal(f.calls.filter(c=>c[0]==='survive').length,2);f.finish();await second;
});
test('only explicit combat decisions use the attack action',async()=>{
  const f=fixture(),done=f.responder.submit({urgent:true,kind:'surrounded',priority:75,params:{kind:'surrounded',entity_id:42}});await tick();
  assert.deepEqual(f.calls[1],['survive','surrounded']);f.finish();await done;
});
test('real executor reports a failed Tac outcome and keeps the original task queued',async()=>{
  const events=new EventBus(),runs=[];const bridge={run(type){let reject;const promise=type==='survive'?Promise.reject(Object.assign(new Error('air exit unstable'),{code:'survival_priority'})):new Promise((_,r)=>{reject=r;});runs.push(type);return {promise,cancel:async()=>{reject?.(Object.assign(new Error('interrupted'),{code:'cancelled'}));await promise.catch(()=>{});}};}};
  const executor=new NativeExecutor({bridge,eventBus:events}),responder=new NativeTacResponder({executor,events});
  executor.enqueuePlan({planId:'keep-work',tasks:[{id:'gather',title:'gather',actions:[{type:'gather_resources',params:{surveyId:'same'}}]}]});
  await responder.submit({urgent:true,kind:'drowning',priority:95,params:{kind:'drowning'}});
  assert.deepEqual(runs,['gather_resources','survive']);assert.equal(executor.paused,true);assert.equal(executor.queueLength,1);
  responder.submit({urgent:false,safe:true});await tick();assert.deepEqual(runs,['gather_resources','survive','gather_resources']);await executor.stop();
});
for(const type of ['gather_resources','build_workarea','build_base'])test(`real executor retains ${type} and dependent work through combat preemption`,async()=>{
  const runs=[],events=new EventBus();const bridge={run(type,params){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});const run={type,params,complete:()=>resolve({result:{},state:{}})};runs.push(run);return {promise,cancel:async()=>{reject(Object.assign(new Error('interrupted'),{code:'cancelled'}));await promise.catch(()=>{});}};}};
  const executor=new NativeExecutor({bridge,eventBus:events});const responder=new NativeTacResponder({executor,events});
  executor.enqueuePlan({planId:'preserve',tasks:[{id:'original',title:'original',actions:[{type,params:{label:'same-objective'}},{type:'mark_anchor',params:{name:'after'}}]}]});
  const done=responder.submit({urgent:true,kind:'combat',priority:30,params:{kind:'combat'}});await tick();
  responder.submit({urgent:true,kind:'surrounded',priority:75,params:{kind:'surrounded'}});await tick();
  assert.deepEqual(runs.map(r=>r.type),[type,'jump_attack','survive']);assert.equal(executor.queueLength,2);
  runs.at(-1).complete();await done;await tick();assert.equal(runs.at(-1).type,type);assert.equal(runs.at(-1).params.label,'same-objective');
  runs.at(-1).complete();await tick();assert.equal(runs.at(-1).type,'mark_anchor');runs.at(-1).complete();await tick();assert.equal(executor.busy,false);assert.equal(executor.queueLength,0);
});
