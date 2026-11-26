import test from "node:test";
import assert from "node:assert/strict";
import { NativeExecutor } from "../src/native/executor.js";
import { EventBus } from "../src/core/events.js";

test("material goal handoff completes the task without reporting a fishbone failure", async () => {
  const events = new EventBus(), warnings = [], completed = [];
  events.on("action-warning", x => warnings.push(x));
  events.on("task-complete", x => completed.push(x));
  const bridge = { run: () => ({ promise: Promise.resolve({ result: { laneId: "50", stopReason: "target_reached", targetReached: false }, state: {} }), cancel: async () => {} }) };
  const executor = new NativeExecutor({ bridge, eventBus: events });
  executor.enqueuePlan({ planId: "diamond-ready", tasks: [{ id: "mine", title: "采钻", actions: [{ type: "fishbone_mine", params: { laneId: "50" } }] }] });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(warnings, []); assert.equal(completed.length, 1);
  assert.equal(executor.busy, false);
});

test("combat interruption resumes the original fishbone and dependent work after Tac finishes", async () => {
  const events = new EventBus(), calls = [], starts = [];
  let cancelMine;
  events.on("action-start", x => starts.push(x));
  const bridge = { run(type, params) {
    calls.push({ type, params });
    if (calls.length === 1) return { promise: new Promise((_, reject) => { cancelMine = () => reject(Object.assign(new Error("interrupted"), { code: "cancelled" })); }), cancel: async () => cancelMine() };
    return { promise: Promise.resolve({ result: type === "fishbone_mine" ? { stopReason: "lane_complete", targetReached: true } : {}, state: {} }), cancel: async () => {} };
  } };
  const executor = new NativeExecutor({ bridge, eventBus: events });
  const mine = { type: "fishbone_mine", params: { laneId: "50" } };
  executor.enqueuePlan({ planId: "original-plan", tasks: [{ id: "original-task", title: "采矿后整理", actions: [mine, { type: "inspect_state", params: {} }] }] });
  await executor.interrupt({ resume: true });
  assert.equal(executor.busy, false);
  assert.equal(executor.queueLength, 2);
  await executor.priority({ type: "jump_attack", params: { entity_id: 123 } }, "tac");
  assert.deepEqual(calls.map(x => x.type), ["fishbone_mine", "jump_attack"]);
  assert.equal(executor.paused, true);
  const done = new Promise(resolve => events.on("task-complete", x => { if (x.taskId === "original-task") resolve(); }));
  executor.resume(); await done;
  assert.deepEqual(calls.map(x => x.type), ["fishbone_mine", "jump_attack", "fishbone_mine", "inspect_state"]);
  assert.deepEqual(calls[2].params, { laneId: "50" });
  const restored = starts.filter(x => x.action.type === "fishbone_mine");
  assert.equal(restored[0].task.id, restored[1].task.id);
  assert.equal(restored[0].planId, restored[1].planId);
});

test("an explicit stop does not requeue the interrupted fishbone", async () => {
  let cancelMine;
  const executor = new NativeExecutor({ eventBus: new EventBus(), bridge: { run: () => ({ promise: new Promise((_, reject) => { cancelMine = () => reject(Object.assign(new Error("stopped"), { code: "cancelled" })); }), cancel: async () => cancelMine() }) } });
  executor.enqueuePlan({ planId: "stop-plan", tasks: [{ id: "mine", title: "采矿", actions: [{ type: "fishbone_mine", params: { laneId: "50" } }] }] });
  await executor.stop();
  assert.equal(executor.busy, false);
  assert.equal(executor.queueLength, 0);
  assert.equal(executor.paused, true);
});

test('stair recovery counts only stair progress and resumes the remaining steps after survival',async()=>{
  const events=new EventBus();let cancel,progress;
  const bridge={run(type,params,{onProgress}={}){progress=onProgress;return {promise:new Promise((_,reject)=>{cancel=()=>reject(Object.assign(new Error('interrupted'),{code:'cancelled'}));}),cancel:async()=>cancel()};}};
  const executor=new NativeExecutor({bridge,eventBus:events});
  executor.enqueuePlan({planId:'stairs',tasks:[{id:'up',title:'继续阶梯',actions:[{type:'staircase_up',params:{direction:'x',steps:20}}]}]});
  progress({phase:'staircase_up',completed:7,total:20});assert.equal(executor.currentAction.params.steps,13);
  progress({phase:'pillar',completed:1,total:1});assert.equal(executor.currentAction.params.steps,13);
  await executor.interrupt({resume:true});assert.equal(executor.queueLength,1);assert.equal(executor.queue[0].action.params.steps,13);assert.equal(executor.queue[0].action.params.direction,'x');
});
