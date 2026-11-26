import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NativeBridge } from "../src/native/bridge.js";
import { normalizeNativePlan } from "../src/native/distribution.js";
import { MemoryArchive } from "../src/memory/memory-archive.js";
import { OpenAICompatibleProvider } from "../src/llm/provider.js";
import { NativeExecutor } from "../src/native/executor.js";

test("LLM aborts are reported as a clear timeout with elapsed time", async () => {
  const traces = [];
  const provider = new OpenAICompatibleProvider({
    baseUrl: "https://example.invalid/v1", apiKey: "test", model: "test",
    fetchImpl: (_, options) => new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")), { once: true })),
    onTrace: trace => traces.push(trace)
  });
  await assert.rejects(provider.complete("distribution", "system", { layer_context: {} }, 0, { timeoutMs: 1000 }), error => error.code === "llm_timeout" && /超时/.test(error.message));
  const failure = traces.find(trace => trace.type === "llm-error");
  assert.match(failure.error.message, /1 秒/);
  assert.equal(typeof failure.durationMs, "number");
});

test("LLM memory context excludes Reflection summaries while retaining durable facts", () => {
  const archive = new MemoryArchive();
  archive.latestSummary = { document: "debug-only reflection" };
  archive.entries = [
    { kind: "failure", source: "action", summary: "stair path blocked", importance: 0.9, lastSeenAt: 2 },
    { kind: "lesson", source: "reflection", summary: "debug-only lesson", importance: 1, lastSeenAt: 3 },
    { kind: "hint", source: "reflection", summary: "debug-only hint", importance: 1, lastSeenAt: 4 }
  ];
  const context = archive.contextSnapshot();
  assert.deepEqual(context.entries.map(item => item.summary), ["stair path blocked"]);
  assert.equal("latestSummary" in context, false);
});

test("compiled C++ navigation splits ordinary movement into roughly nine-block legs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-native-"));
  let pos = [0.5, 64, 0.5]; const moves = [];
  const api = { async request(url, options = {}) {
    const body = options.body || {};
    if (url === "/status") return { ok: true, result: { pos, alive: true, ready: true, health: 20, dimension: "overworld", on_ground: true } };
    if (url === "/inventory") return { ok: true, result: { items: [], empty_slots: 36 } };
    if (url === "/get_block") { const [x,y,z] = body.pos;return { ok: true, result: { name: y < 64 ? "stone" : "air", pos: [x,y,z], diggable: true } }; }
    if (url === "/move_to") { moves.push(body);pos=[body.x,body.y,body.z];return { ok: true, result: { pos } }; }
    throw new Error(`unexpected API request ${url}`);
  }, async stop() { return { ok: true }; } };
  const bridge = new NativeBridge({ api, stateFile: path.join(dir, "state.json") });
  try {
    const result = await bridge.run("move_to", { target: [30,64,0] }).promise;
    assert.equal(result.result.reached, true);
    assert.deepEqual(moves.map(move => Math.round(move.x - 0.5)), [9,18,27,30]);
  } finally { bridge.close();await rm(dir,{recursive:true,force:true}); }
});

test("compiled C++ chains validated walking legs from move responses without status round trips", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-native-chain-"));
  let pos = [0.5, 64, 0.5]; const calls = [];
  const api = { async request(url, options = {}) {
    const body = options.body || {}; calls.push(url);
    if (url === "/status") return { ok: true, result: { pos, alive: true, ready: true, health: 20, dimension: "overworld", on_ground: true } };
    if (url === "/inventory") return { ok: true, result: { items: [], empty_slots: 36 } };
    if (url === "/get_block") { const [x,y,z] = body.pos; return { ok: true, result: { name: y < 64 ? "stone" : "air", pos: [x,y,z], diggable: true } }; }
    if (url === "/move_to") { pos = [body.x, body.y, body.z]; return { ok: true, result: { pos } }; }
    throw new Error(`unexpected API request ${url}`);
  }, async stop() { return { ok: true }; } };
  const bridge = new NativeBridge({ api, stateFile: path.join(dir, "state.json") });
  try {
    const result = await bridge.run("move_to", { target: [30,64,0] }).promise;
    assert.equal(result.result.reached, true);
    const moves = calls.map((url, index) => url === "/move_to" ? index : -1).filter(index => index >= 0);
    assert.equal(moves.length, 4);
    assert.equal(calls.slice(moves[0] + 1, moves[1]).includes("/status"), false);
    assert.equal(calls.slice(moves[1] + 1, moves[2]).includes("/status"), false);
    assert.equal(calls.slice(moves[2] + 1, moves[3]).includes("/status"), false);
  } finally { bridge.close(); await rm(dir,{recursive:true,force:true}); }
});

test("compiled C++ recipe preflight refuses craft API when materials are short", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-native-")); const calls=[];
  const api={ async request(url,options={}) { calls.push(url);if(url==="/inventory")return {ok:true,result:{items:[{name:"iron_ingot",count:2},{name:"stick",count:2}],empty_slots:30}};throw new Error(`unexpected API request ${url}`); } };
  const bridge=new NativeBridge({api,stateFile:path.join(dir,"state.json")});
  try {
    const outcome=await bridge.run("craft",{item:"iron_pickaxe",count:1}).promise;
    assert.equal(outcome.result.code,"missing_ingredients");assert.ok(outcome.result.details.missing.some(item=>item.item==="iron_ingot"));
    assert.equal(calls.includes("/craft"),false);
  } finally { bridge.close();await rm(dir,{recursive:true,force:true}); }
});

test("compiled C++ recipe DAG checks missing workstation ingredients before any craft call", async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),"mc-native-"));const calls=[];
  const api={async request(url,options={}){calls.push(url);if(url==="/inventory")return {ok:true,result:{items:[{name:"iron_ingot",count:3},{name:"stick",count:2}],empty_slots:30}};if(url==="/status")return {ok:true,result:{pos:[0.5,64,0.5],alive:true,ready:true,dimension:"overworld"}};if(url==="/find_blocks")return {ok:true,result:{blocks:[]}};throw new Error(`unexpected API request ${url}`);}};
  const bridge=new NativeBridge({api,stateFile:path.join(dir,"state.json")});
  try { const outcome=await bridge.run("craft",{item:"iron_pickaxe",count:1}).promise;assert.equal(outcome.result.code,"missing_ingredients");assert.ok(outcome.result.details.missing.some(item=>item.item.includes("planks")));assert.equal(calls.includes("/craft"),false); }
  finally { bridge.close();await rm(dir,{recursive:true,force:true}); }
});

test("compiled C++ place script verifies an adjacent solid support and confirms placement", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mc-native-place-"));
  let placed = false; const calls = [];
  const api = { async request(url, options = {}) {
    const body = options.body || {}; calls.push(url);
    if (url === "/status") return { ok: true, result: { pos: [0.5, 64, 0.5], alive: true, ready: true, dimension: "overworld" } };
    if (url === "/inventory") return { ok: true, result: { items: [{ name: "furnace", count: 1 }], empty_slots: 35 } };
    if (url === "/get_block") {
      const [x, y, z] = body.pos;
      if (x === 1 && y === 63 && z === 0) return { ok: true, result: { name: "stone" } };
      if (x === 1 && y === 64 && z === 0) return { ok: true, result: { name: placed ? "furnace" : "air" } };
      return { ok: true, result: { name: "air" } };
    }
    if (url === "/place") { placed = true; return { ok: true, result: {} }; }
    throw new Error(`unexpected API request ${url}`);
  } };
  const bridge = new NativeBridge({ api, stateFile: path.join(dir, "state.json") });
  try {
    const outcome = await bridge.run("place", { item: "furnace", pos: [1, 64, 0] }).promise;
    assert.deepEqual(outcome.result, { placed: "furnace", pos: [1, 64, 0] });
    assert.equal(calls.filter(url => url === "/place").length, 1);
  } finally { bridge.close(); await rm(dir, { recursive: true, force: true }); }
});

test("compiled fishbone finishes its recorded main lane and both branches after collecting visible ore", async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),"mc-fishbone-"));let pos=[0.5,64,0.5],coal=0;const dug=new Set();
  const key=point=>point.join(",");
  const api={async request(url,options={}){const body=options.body||{};
    if(url==="/status")return {ok:true,result:{pos,alive:true,ready:true,health:20,food:20,dimension:"overworld",held:{name:"stone_pickaxe"},on_ground:true}};
    if(url==="/inventory")return {ok:true,result:{items:[{name:"stone_pickaxe",count:1},{name:"coal",count:coal}],empty_slots:30,held:{name:"stone_pickaxe",count:1}}};
    if(url==="/find_blocks")return {ok:true,result:{blocks:[]}};
    if(url==="/get_block"){const name=dug.has(key(body.pos))||(body.pos[0]===0&&body.pos[2]===0&&body.pos[1]>=64)?"air":body.pos[1]<64?"stone":key(body.pos)==="1,64,0"?"coal_ore":"stone";return {ok:true,result:{name,pos:body.pos,diggable:true}};}
    if(url==="/dig"){dug.add(key(body.pos));if(key(body.pos)==="1,64,0")coal++;return {ok:true,result:{}};}
    if(url==="/move_to"){pos=[body.x,body.y,body.z];return {ok:true,result:{pos}};}
    if(url==="/stop")return {ok:true,result:{}};
    throw new Error(`unexpected API request ${url}`);
  }};
  const stateFile=path.join(dir,"state.json"),bridge=new NativeBridge({api,stateFile,executable:process.env.NATIVE_TEST_EXE});
  try{
    const progress=[];
    const result=await bridge.run("fishbone_mine",{laneId:"test-lane",direction:"x",length:2,branchLength:1,branchEvery:2},{onProgress:p=>progress.push(p)}).promise;
    assert.equal(result.result.stopReason,"lane_complete",JSON.stringify(result));assert.equal(result.result.oresCollected,1);assert.deepEqual(result.result.origin,[0,64,0]);assert.deepEqual(result.result.mainEnd,[2,64,0]);
    const saved=JSON.parse(await (await import("node:fs/promises")).readFile(stateFile,"utf8")).fishboneRoutes["fishbone:test-lane"];
    assert.equal(saved.phase,"complete");assert.equal(saved.branches.length,2);assert.ok(saved.branches.every(branch=>branch.hub.join(",")==="2,64,0"));
    const timed=progress.filter(p=>p.workTotal!==undefined);
    assert.ok(timed.length>2);assert.ok(timed.every(p=>p.workTotal===4));
    assert.equal(timed.filter(p=>p.phase==="fishbone_main").at(-1).workCompleted,2);
    assert.equal(timed.at(-1).workCompleted,4);
  }finally{bridge.close();await rm(dir,{recursive:true,force:true});}
});

test("compiled fishbone hands danger to Tac before any digging", async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),"mc-fishbone-danger-"));let digCalls=0;
  const api={async request(url){if(url==="/status")return {ok:true,result:{pos:[0.5,64,0.5],alive:true,ready:true,health:20,food:20,dimension:"overworld",held:{name:"stone_pickaxe"},in_lava:true}};if(url==="/inventory")return {ok:true,result:{items:[{name:"stone_pickaxe",count:1}],empty_slots:30}};if(url==="/find_blocks")return {ok:true,result:{blocks:[]}};if(url==="/dig"){digCalls++;return {ok:true,result:{}};}throw new Error(`unexpected API request ${url}`);}};
  const bridge=new NativeBridge({api,stateFile:path.join(dir,"state.json"),executable:process.env.NATIVE_TEST_EXE});
  try{await assert.rejects(bridge.run("fishbone_mine",{laneId:"danger-test",stopWhen:["lane_complete"]}).promise,error=>error.code==="survival_priority");assert.equal(digCalls,0);}finally{bridge.close();await rm(dir,{recursive:true,force:true});}
});

test("compiled fishbone returns a no-tool stop instead of rescheduling the lane", async () => {
  const dir=await mkdtemp(path.join(os.tmpdir(),"mc-fishbone-no-tool-"));
  const api={async request(url){if(url==="/status")return {ok:true,result:{pos:[0.5,64,0.5],alive:true,ready:true,health:20,food:20,dimension:"overworld",held:null}};if(url==="/inventory")return {ok:true,result:{items:[],empty_slots:30}};if(url==="/find_blocks")return {ok:true,result:{blocks:[]}};throw new Error(`unexpected API request ${url}`);}};
  const bridge=new NativeBridge({api,stateFile:path.join(dir,"state.json")});
  try{const result=await bridge.run("fishbone_mine",{laneId:"no-tool-test"}).promise;assert.equal(result.result.stopReason,"no_tool");assert.equal(result.result.targetReached,false);}finally{bridge.close();await rm(dir,{recursive:true,force:true});}
});

test("resident C++ Tac monitor raises an emergency without an LLM request", async () => {
  const bridge = new NativeBridge({ api: {} });
  try {
    const decision = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Tac monitor did not answer")), 5000);
      const monitor = bridge.monitor(value => { clearTimeout(timer);monitor.close();resolve(value); }, reject);
      monitor.send({ status: { alive: true, ready: true, in_lava: true, health: 20, pos: [0,64,0] }, entities: [] });
    });
    assert.equal(decision.urgent, true);
    assert.equal(decision.kind, "lava");
  } finally { bridge.close(); }
});

test("Distribution accepts complete scripts and rejects raw API tool calls", () => {
  const plan=normalizeNativePlan({tasks:[{title:"采树",actions:[{type:"chop_tree",params:{targetCount:12}}]}]});
  assert.equal(plan.tasks[0].actions[0].type,"chop_tree");
  assert.throws(()=>normalizeNativePlan({tasks:[{actions:[{type:"dig",params:{pos:[0,64,0]}}]}]}),/仅允许 C\+\+ 自动化脚本/);
});

test("Distribution exposes the resumable cottage building script", () => {
  const plan = normalizeNativePlan({tasks:[{title:"建小家",actions:[{type:"build_house",params:{width:7,depth:7,style:"cottage"}}]}]});
  assert.equal(plan.tasks[0].actions[0].type, "build_house");
});

test("failed navigation creates one local recovery step without inserting inspection work", async () => {
  const { NativeDistribution } = await import("../src/native/distribution.js");
  const { EventBus } = await import("../src/core/events.js");
  const events = new EventBus(); let recovery;
  events.on("action-recovery-plan", data => { recovery = data; });
  const distribution = new NativeDistribution({ provider: {}, eventBus: events, memory: { snapshot: () => ({}) }, memoryArchive: { contextSnapshot: () => ({}) } });
  const plan = distribution.replanAfterFailure({ action: { type: "move_to", params: { target: [3, 20, 4] } }, error: { code: "path_not_found" } });
  assert.equal(plan.noThink, true);
  assert.equal(plan.tasks[0].failureRecovery, true);
  assert.equal(normalizeNativePlan(plan).tasks[0].failureRecovery, true);
  assert.deepEqual(plan.tasks[0].actions[0], { type: "navigation_recover", params: { target: [3, 20, 4] } });
  assert.equal(recovery.context.noThink, true);
  const failedCraft = distribution.replanAfterFailure({ action: { type: "workshop", params: {} }, error: { code: "missing_ingredients" } });
  assert.equal(failedCraft.noThink, true);
  assert.deepEqual(failedCraft.tasks, []);
});

test("temporary API read failures retry the active script and keep the rest of its task", async () => {
  const { EventBus } = await import("../src/core/events.js");
  const events = new EventBus();let calls = 0, completed = 0, retries = 0;
  const bridge = { run: () => ({ promise: ++calls === 1 ? Promise.reject(Object.assign(new Error("network down"), { code: "network_error" })) : Promise.resolve({ result: {}, state: {} }), cancel: async () => {} }) };
  events.on("action-end", () => { completed++; });events.on("action-retry-scheduled", () => { retries++; });
  const executor = new NativeExecutor({ bridge, eventBus: events });
  executor.enqueuePlan({ planId: "plan", tasks: [{ id: "task", title: "continue", actions: [{ type: "chop_tree", params: { targetCount: 8 } }, { type: "mark_anchor", params: { name: "home" } }] }] });
  await new Promise(resolve => { const check = setInterval(() => { if (completed === 2) { clearInterval(check);resolve(); } }, 5); });
  assert.equal(calls, 3);
  assert.equal(retries, 1);
  assert.equal(completed, 2);
});

test("the same distribution plan cannot be enqueued twice by overlapping dispatch paths", async () => {
  const { EventBus } = await import("../src/core/events.js");
  const events = new EventBus();let calls = 0, duplicates = 0;
  const bridge = { run: () => ({ promise: new Promise(resolve => { calls++;setTimeout(() => resolve({ result: {}, state: {} }), 10); }), cancel: async () => {} }) };
  events.on("distribution-plan-duplicate-ignored", () => { duplicates++; });
  const executor = new NativeExecutor({ bridge, eventBus: events });
  const plan = { planId: "overlapping-plan", tasks: [{ id: "one", title: "one", actions: [{ type: "inspect_state", params: {} }] }] };
  assert.equal(executor.enqueuePlan(plan), true);
  assert.equal(executor.enqueuePlan(plan), false);
  await new Promise(resolve => { const check = setInterval(() => { if (!executor.busy && calls) { clearInterval(check);resolve(); } }, 5); });
  assert.equal(calls, 1);
  assert.equal(duplicates, 1);
});

test("recoverable script warnings stop dependent actions and are surfaced separately from errors", async () => {
  const { EventBus } = await import("../src/core/events.js");
  const events = new EventBus();let calls = 0, warning, errors = 0;
  const bridge = { run: () => ({ promise: Promise.resolve({ result: ++calls === 1 ? { warning: true, code: "site_unavailable", message: "换一处岩壁" } : {}, state: {} }), cancel: async () => {} }) };
  events.on("action-warning", data => { warning = data; });events.on("action-error", () => { errors++; });
  const executor = new NativeExecutor({ bridge, eventBus: events });
  executor.enqueuePlan({ planId: "warn-plan", tasks: [{ id: "warn-task", title: "据点", actions: [{ type: "build_workarea", params: {} }, { type: "workshop", params: {} }] }] });
  await new Promise(resolve => { const check = setInterval(() => { if (warning) { clearInterval(check);resolve(); } }, 5); });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls, 1);
  assert.equal(errors, 0);
  assert.equal(warning.warning.code, "site_unavailable");
});

test("incomplete fishbone work stops every queued job and preserves its exact lane task", async () => {
  const { EventBus } = await import("../src/core/events.js");
  const events = new EventBus();let calls=0,incomplete;
  events.on("task-incomplete", data => { incomplete=data; });
  const bridge={run:()=>({promise:Promise.resolve({result:{laneId:"2",targetReached:false,stopReason:"resume_required",origin:[0,40,0],mainEnd:[12,40,0],route:{phase:"branches"}},state:{}}),cancel:async()=>{}})};
  const executor=new NativeExecutor({bridge,eventBus:events});
  executor.enqueuePlan({planId:"lane-plan",tasks:[{id:"lane-2",title:"魚骨2号线",actions:[{type:"fishbone_mine",params:{laneId:"2"}},{type:"workshop",params:{mode:"craft",items:[{item:"torch",count:4}]}}]},{id:"other",title:"别的工作",actions:[{type:"inspect_state",params:{}}]}]});
  executor.bridge={run:()=>{calls++;return {promise:Promise.resolve({result:{},state:{}}),cancel:async()=>{}};}};
  await new Promise(resolve=>{const timer=setInterval(()=>{if(incomplete){clearInterval(timer);resolve();}},5);});
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(incomplete.task.id,"lane-2");
  assert.deepEqual(incomplete.result.origin,[0,40,0]);
  assert.equal(calls,0);
  assert.equal(executor.queueLength,0);
});

test("distribution restores an interrupted queued action from disk without changing its target", async () => {
  const { NativeDistribution }=await import("../src/native/distribution.js");
  const { EventBus }=await import("../src/core/events.js");
  const dir=await mkdtemp(path.join(os.tmpdir(),"mc-distribution-")),file=path.join(dir,"state.json"),events=new EventBus();
  try {
    const first=new NativeDistribution({provider:{},eventBus:events,memory:{snapshot:()=>({})},memoryArchive:{contextSnapshot:()=>({})},filePath:file});
    events.emit("action-start",{actionIndex:1,action:{type:"fishbone_mine",params:{laneId:"2"}},task:{id:"lane-2",title:"鱼骨2号线",goal:"延伸固定主道",actions:[{type:"workshop",params:{}},{type:"fishbone_mine",params:{laneId:"2"}}]}});
    events.emit("action-progress",{action:{type:"fishbone_mine",params:{laneId:"2"}},progress:{phase:"fishbone_branch",hub:[12,40,0],end:[12,40,4]}});
    await first.persist();
    const restored=new NativeDistribution({provider:{},eventBus:new EventBus(),memory:{snapshot:()=>({})},memoryArchive:{contextSnapshot:()=>({})},filePath:file});await restored.load();
    const plan=await restored.replan({status:{alive:true}},{execution:{},queuedTasks:[]});
    assert.equal(plan.tasks[0].id,"lane-2");assert.deepEqual(plan.tasks[0].actions,[{type:"fishbone_mine",params:{laneId:"2"}}]);
    assert.deepEqual(restored.continuationProgress.end,[12,40,4]);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("Distribution preserves the failed task and asks to repair and redelegate it", async () => {
  const { NativeDistribution } = await import("../src/native/distribution.js");
  const { EventBus } = await import("../src/core/events.js");
  const events = new EventBus();let context;
  const original = { planId: "original", tasks: [{ id: "base", title: "建立据点", goal: "在岩壁内开凿两格高工作区", actions: [{ type: "build_workarea", params: {} }] }] };
  const distribution = new NativeDistribution({ provider: { createAutomationPlan: async input => { context = input.context;return { rationale: "修复前置条件", tasks: [{ title: "寻找另一处岩壁", actions: [{ type: "build_workarea", params: { direction: "x" } }] }] }; } }, eventBus: events, memory: { snapshot: () => ({}) }, memoryArchive: { contextSnapshot: () => ({}) } });
  distribution.currentPlan = original;
  distribution.replanAfterFailure({ action: { type: "build_workarea", params: {} }, task: original.tasks[0], taskId: "base", error: { code: "workarea_site_unavailable", message: "没有可挖岩壁" } });
  assert.equal(distribution.currentPlan, original);
  events.emit("action-error", { action: { type: "build_workarea", params: {} }, task: original.tasks[0], taskId: "base", error: { code: "workarea_site_unavailable", message: "没有可挖岩壁" } });
  await distribution.replan({}, { execution: {}, queuedTasks: [] });
  assert.equal(context.taskContinuity.mode, "repair_and_continue");
  assert.equal(context.taskContinuity.activeTask.title, "建立据点");
  assert.equal(context.failedTask.goal, original.tasks[0].goal);
});

test("Distribution resumes a newer continuation despite an older warning", async () => {
  const { NativeDistribution } = await import("../src/native/distribution.js");
  const { EventBus } = await import("../src/core/events.js");
  const events = new EventBus();
  let context;
  const distribution = new NativeDistribution({
    provider: { createAutomationPlan: async input => {
      context = input.context;
      return { tasks: [{ title: "继续脱离密闭坑", actions: [{ type: "move_to", params: { target: [-181, -35, -253], construct: true } }] }] };
    } },
    eventBus: events, memory: { snapshot: () => ({}) }, memoryArchive: { contextSnapshot: () => ({}) }, filePath: null
  });
  events.emit("action-warning", { action: { type: "staircase_down", params: { direction: "-x" } }, task: { id: "old", title: "旧阶梯", actions: [] }, taskId: "old", warning: { code: "unsafe_navigation", message: "旧失败" } });
  events.emit("action-start", { actionIndex: 0, action: { type: "move_to", params: { target: [-181, -35, -253], construct: true } }, task: { id: "escape", title: "脱离密闭坑", actions: [{ type: "move_to", params: { target: [-181, -35, -253], construct: true } }] } });
  const plan = await distribution.replan({ status: { alive: true } }, { execution: {}, queuedTasks: [] });
  assert.equal(context, undefined);
  assert.equal(distribution.lastFailure, null);
  assert.equal(plan.tasks[0].id, "escape");
  assert.equal(plan.tasks[0].title, "脱离密闭坑");
});

test("workarea failures respect cooldown and stop after repeating at the same checkpoint", async () => {
  const { NativeDistribution } = await import("../src/native/distribution.js");
  const { EventBus } = await import("../src/core/events.js");
  const events = new EventBus();
  const task = { id: "base", title: "建工作区", actions: [{ type: "build_workarea", params: { name: "Y24熔炼工作区", direction: "x" } }] };
  let generated = 0;
  const distribution = new NativeDistribution({ provider: { createAutomationPlan: async () => { generated++; return { tasks: [{ title: "重复工作区", actions: [{ type: "build_workarea", params: task.actions[0].params }] }] }; } }, eventBus: events, memory: { snapshot: () => ({}) }, memoryArchive: { contextSnapshot: () => ({}) }, filePath: null });
  const emitFailure = () => events.emit("action-warning", { action: task.actions[0], task, taskId: task.id, warning: { code: "workarea_incomplete", result: { completed: 7 }, message: "navigation_failed" } });
  emitFailure();
  assert.equal(distribution.resumeExact, true);
  assert.equal(distribution.continuingTask.id, "base");
  assert.equal((await distribution.replan({ status: { alive: true } }, { execution: {} })).tasks.length, 0);
  emitFailure();
  assert.equal(distribution.resumeExact, false);
  assert.equal(distribution.continuingTask, null);
  assert.equal(distribution.lastFailure.error.code, "workarea_stalled");
  assert.equal((await distribution.replan({ status: { alive: true } }, { execution: {} })).tasks.length, 0);
  assert.equal((await distribution.replan({ status: { alive: true } }, { execution: {} })).tasks.length, 0);
  assert.equal(generated, 1);
});
