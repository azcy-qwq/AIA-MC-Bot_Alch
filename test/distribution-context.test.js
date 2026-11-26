import test from "node:test";
import assert from "node:assert/strict";
import { buildDistributionContext } from "../src/native/distribution-context.js";

test('a completed diamond kit permits underground expansion instead of keeping the obsolete mining ban',()=>{
  const armor=Object.fromEntries(['helmet','chestplate','leggings','boots'].map((kind,i)=>[kind,{name:'diamond_'+kind,count:1,slot:5+i}]));
  const context=buildDistributionContext({snapshot:{status:{pos:[0,-55,0],dimension:'overworld'},inventory:{items:[{name:'diamond_pickaxe',count:1},{name:'diamond',count:4}],armor}},strategicPlan:{mission:'钻石装备后扩建附魔区'},nativeState:{},execution:{},activeTask:{actions:[{type:'fishbone_mine',params:{laneId:'1'}}]}});
  assert.deepEqual(context.control.forbiddenActions,[]);assert.equal(context.earlySurvivalFlow.diamondBudget.missing,0);
});

const base = () => ({ snapshot: { observedAt: Date.now(), status: { pos: [0, 29, 0], dimension: "overworld", alive: true, ready: true, health: 20, food: 15 }, inventory: { items: [{ name: "stone_pickaxe", count: 1 }, { name: "coal", count: 4 }], empty_slots: 30 } }, scriptCatalog: { fishbone_mine: { laneId: "1" } }, continuityMode: "reassess" });

test("Distribution receives nearby geometry and deficits without full routes or recipe trees", () => {
  const input = base();
  input.snapshot.spatial = { origin: [0,29,0], ownColumn: [{y:28,name:"stone"}], columns: [{direction:"x",feet:"stone",head:"air"}], slices: [{y:29,rows:["#@#"]}], hazards: [] };
  input.nativeState = { anchors: { home: { pos: [4,29,0], dimension: "overworld" } }, routes: { hugeRoute: { points: Array.from({length:1000},(_,i)=>[i,29,0]) } }, workareas: [], fishboneRoutes: {} };
  input.snapshot.advancements = { advancements: [{ arbitrary: "unrelated advancement" }] };
  const result = buildDistributionContext(input);
  assert.deepEqual(result.spatial.columns, input.snapshot.spatial.columns);
  assert.equal(result.nativeState.anchors[0].name, "home");
  assert.equal("routes" in result.nativeState, false);
  assert.equal("craftingTree" in result, false);
  assert.equal("completedAdvancements" in result, false);
  assert.ok(result.craftReadiness.every(target => Array.isArray(target.missing) && !("tree" in target)));
  assert.ok(JSON.stringify(result).length < 6500);
  assert.equal(input.nativeState.routes.hugeRoute.points.length, 1000);
});

test("Distribution retains bounded historic supply-cache locations without allowing field deposits", () => {
  const input=base();
  input.nativeState={supplyCaches:Object.fromEntries(Array.from({length:5},(_,i)=>[String(i),{dimension:"overworld",pos:[i,29,0],stored:[{item:"lapis_lazuli",count:97}],verifiedAt:1}]))};
  const result=buildDistributionContext(input);
  assert.equal(result.storagePolicy.fieldDeposits,false);
  assert.equal(result.nativeState.recordedSupplyCaches.length,2);
  assert.ok(result.nativeState.recordedSupplyCaches.every(c=>c.requiresRecheck&&c.recordedContents[0].item==="lapis_lazuli"));
  assert.equal(result.inventory.items.some(i=>i.name==="lapis_lazuli"&&i.count===97),false);
});

test("Distribution keeps active-lane progress and relevant memory but omits Reflection", () => {
  const input = base();
  input.activeTask = { id:"lane-task", title:"继续原矿道", goal:"扩大可视面积", actions:[{type:"fishbone_mine",params:{laneId:"7"}}] };
  input.nativeState = { fishboneRoutes: { seven: {laneId:"7",phase:"branches",origin:[0,29,0],end:[30,29,0],mainStep:30,branchHub:9,branchStep:2,branches:Array(100).fill({large:"full geometry"})}, other:{laneId:"8",phase:"main"} } };
  input.memoryArchive = { entries:[{key:"work",kind:"progress",summary:"7号矿道已完成主道",source:"action",lastSeenAt:Date.now(),detail:{action:"fishbone_mine"}},{key:"reflection",kind:"lesson",summary:"DEBUG_ONLY",source:"reflection",lastSeenAt:Date.now()}] };
  const result = buildDistributionContext(input);
  assert.deepEqual(result.taskContinuity.activeTask.actions, input.activeTask.actions);
  assert.equal(result.nativeState.fishboneRoutes.length,1);
  assert.equal(result.nativeState.fishboneRoutes[0].branchStep,2);
  assert.equal("branches" in result.nativeState.fishboneRoutes[0],false);
  assert.equal(result.memory.facts[0].summary,"7号矿道已完成主道");
  assert.equal(JSON.stringify(result).includes("DEBUG_ONLY"),false);
});

test("Distribution crafting readiness retains smelting prerequisites without embedding the DAG", () => {
  const input=base();
  input.activeTask={actions:[{type:"craft",params:{item:"iron_pickaxe",count:1}}]};
  input.snapshot.inventory.items.push({name:"raw_iron",count:3},{name:"stick",count:2},{name:"furnace",count:1},{name:"crafting_table",count:1});
  const result=buildDistributionContext(input).craftReadiness.find(target=>target.item==="iron_pickaxe");
  assert.ok(result.processing.some(step=>step.kind==="smelt"&&step.item==="iron_ingot"));
  assert.ok(result.processing.some(step=>step.kind==="craft"&&step.item==="iron_pickaxe"));
  assert.equal("tree" in result,false);
});

test("idle Distribution sees nearby lanes and tool wear instead of the last alphabetic lane ids",()=>{
  const input=base();input.snapshot.inventory.items.push({name:"iron_pickaxe",count:1,durability_used:248,slot:38});
  input.nativeState={fishboneRoutes:{a:{laneId:"a",origin:[0,29,0],end:[1,29,0],mainStep:1},y:{laneId:"y",origin:[200,10,0],mainStep:0},z:{laneId:"z",origin:[100,10,0],mainStep:0}},workareas:[{name:"home",entrance:[2,29,0],exit:[3,29,0]}]};
  const context=buildDistributionContext(input);
  assert.equal(context.nativeState.fishboneRoutes[0].laneId,"a");assert.equal(context.nativeState.fishboneRoutes[0].provisionalEntry,false);
  assert.deepEqual(context.inventory.toolDurability,[{name:"iron_pickaxe",used:248,slot:38}]);assert.deepEqual(context.nativeState.workareas[0].exit,[3,29,0]);
});

test("Distribution reserves historic and provisional ids and states the real discard policy",()=>{
  const input=base();
  input.nativeState={anchors:{empty:null},fishboneRoutes:{"fishbone:49":{laneId:"49",phase:"branches",origin:[-141,5,-252]},"fishbone:50":null,"fishbone:2":{laneId:"2",dimension:"nether",origin:[0,29,0]}}};
  const context=buildDistributionContext(input);
  assert.equal(context.nativeState.nextUnusedLaneId,"51");
  assert.equal(context.nativeState.fishboneRoutes.length,1);
  assert.ok(context.control.discardableItems.includes("cobbled_deepslate"));
  assert.ok(!context.control.discardableItems.includes("redstone"));
  assert.ok(!context.control.discardableItems.includes("diamond"));
});

test('an active smelting repair includes furnace material readiness in the compact context',()=>{
  const input=base();input.strategicPlan={mission:'附魔资源准备'};input.activeTask={actions:[{type:'workshop',params:{mode:'smelt',item:'raw_iron',count:3}}]};
  const context=buildDistributionContext(input),furnace=context.craftReadiness.find(v=>v.item==='furnace');
  assert.ok(furnace);assert.equal(furnace.ok,false);assert.ok(furnace.missing.length);assert.ok(context.control.discardableItems.includes('leaf_litter'));assert.ok(!context.control.discardableItems.includes('flint'));
});
