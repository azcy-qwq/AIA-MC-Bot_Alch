import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventBus} from '../src/core/events.js';
import {NativeDistribution} from '../src/native/distribution.js';

const task = {id:'surface-gather',title:'继续原地表采集',actions:[{type:'gather_resources',params:{surveyId:'existing-survey',targets:[{item:'sugar_cane',count:138},{item:'leather',count:46}]}}]};
function create(events, filePath=null) {
  return new NativeDistribution({provider:{createAutomationPlan(){throw new Error('resuming work must not call the model');}},eventBus:events,memory:{snapshot:()=>({})},memoryArchive:{contextSnapshot:()=>({})},filePath});
}
function emergency(events,source) {
  const action={type:source==='tac'?'survive':'recover_loot',params:{}},t={id:source+'-1',title:source,actions:[action]};
  const data={source,task:t,taskId:t.id,action,taskLast:true};
  events.emit('action-start',data);
  events.emit('action-warning',{...data,warning:{code:'survival_priority'}});
  events.emit('action-error',{...data,error:{code:'unsafe_navigation',message:'stay protected'}});
  events.emit('task-incomplete',{...data,result:{checkpoint:'rescue'}});
  events.emit('action-end',{...data,result:{safe:true}});
  events.emit('task-complete',{taskId:t.id});
}
for(const source of ['tac','death-recovery']) test(source+' events preserve the original resource objective and exact continuation',async()=>{
  const events=new EventBus(),d=create(events);
  events.emit('action-start',{source:'action:'+task.id,task,action:task.actions[0]});
  emergency(events,source);
  assert.deepEqual(d.continuingTask,task);assert.equal(d.resumeExact,true);assert.equal(d.lastFailure,null);
  const plan=await d.replan({status:{alive:true}},{});
  assert.deepEqual(plan.tasks[0].actions,task.actions);assert.equal(plan.tasks[0].id,task.id);
});
test('successful protection cannot clear an unresolved ordinary resource failure',()=>{
  const events=new EventBus(),d=create(events);
  events.emit('action-start',{source:'action:'+task.id,task,action:task.actions[0]});
  events.emit('action-error',{task,taskId:task.id,action:task.actions[0],error:{code:'inventory_full',message:'make room'}});
  const before=structuredClone(d.lastFailure);
  emergency(events,'tac');
  assert.deepEqual(d.lastFailure,before);assert.deepEqual(d.continuingTask,task);assert.equal(d.resumeExact,false);
});
test('restart during emergency persists and resumes the original resource job without a model request',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'mc-resource-continuity-'));
  try {
    const file=path.join(dir,'distribution.json'),events=new EventBus(),first=create(events,file);
    events.emit('action-start',{source:'action:'+task.id,task,action:task.actions[0]});
    emergency(events,'tac');await first.persist();
    const restored=create(new EventBus(),file);await restored.load();
    const plan=await restored.replan({status:{alive:true}},{});
    assert.equal(plan.tasks[0].id,task.id);assert.deepEqual(plan.tasks[0].actions,task.actions);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('when Tac cannot heal, the dispatcher starts nearby wood collection without waiting for a model',async()=>{
  const events=new EventBus(),d=create(events);
  const action={type:'navigation_recover',params:{target:[0,64,0]}};
  events.emit('action-error',{task:{id:'old-recovery',actions:[action]},action,error:{code:'survival_priority'}});
  const snapshot={status:{alive:true,on_ground:true,dimension:'overworld',health:6.9,food:17},
    inventory:{items:[]},blocks:{blocks:{birch_log:{dist:8.6}}}};
  const nativeState={combat:{healingDeferred:{dimension:'overworld',health:6.9,food:17}}};
  const plan=await d.replan(snapshot,{nativeState});
  assert.deepEqual(plan.tasks[0].actions,[{type:'chop_tree',params:{targetCount:8,radius:12,exploreSteps:0}}]);
});
