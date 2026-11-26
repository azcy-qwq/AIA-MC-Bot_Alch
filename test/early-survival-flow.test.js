import test from "node:test";
import assert from "node:assert/strict";
import { estimateEarlySurvivalProgress } from "../src/strategy/early-survival-flow.js";

test("early survival flow estimates the next stage from inventory and depth evidence", () => {
  const starter = estimateEarlySurvivalProgress({ environment: { status: { pos: [0, 91, 0] }, inventory: { items: [{ name: "crafting_table", count: 1 }] } } });
  assert.equal(starter.phases[0].status, "done");
  assert.equal(starter.phases[1].status, "active");
  const underground = estimateEarlySurvivalProgress({ environment: { status: { pos: [0, 39, 0] }, inventory: { items: [{ name: "stone_pickaxe", count: 1 }, { name: "stone_axe", count: 1 }, { name: "coal", count: 8 }] } }, nativeState: { workareas: [] } });
  assert.equal(underground.phases[4].status, "done");
  assert.equal(underground.phases[5].status, "active");
  const advanced = estimateEarlySurvivalProgress({ environment: { status: { pos: [0, 64, 0] }, inventory: { items: [{ name: "iron_pickaxe", count: 1 }, { name: "iron_axe", count: 1 }] } } });
  assert.equal(advanced.phases[1].status, "done");
  assert.equal(advanced.phases[2].status, "done");
});

test('extended route deducts real worn equipment and does not double count held inventory slots',()=>{
  const armor=Object.fromEntries(['helmet','chestplate','leggings','boots'].map((part,i)=>[part,{name:'diamond_'+part,count:1,slot:5+i}]));
  const result=estimateEarlySurvivalProgress({environment:{status:{pos:[0,64,0]},inventory:{items:[{name:'diamond_pickaxe',count:1,slot:38},{name:'diamond',count:4,slot:24}],held:{name:'diamond',count:4,slot:24},armor}},nativeState:{workareas:[{dimension:'overworld'}],fishboneRoutes:{deep:{mainStep:1,dimension:'overworld',origin:[0,-55,0]}}}});
  assert.deepEqual(result.diamondBudget,{total:31,craftedCredit:27,loose:4,missing:0});
  assert.match(result.phases.find(p=>p.id==='diamond-resources').evidence,/护甲24\/24、镐3\/3/);
  assert.equal(result.phases.find(p=>p.id==='diamond-resources').status,'done');
  assert.equal(result.phases.find(p=>p.id==='deep-descent').status,'done');
  assert.ok(result.phases.find(p=>p.id==='enchanting').optional);
  assert.ok(!result.phases[5].target.includes('5×5×3'));
});

test('current iron armor does not retain credit for a historical diamond set',()=>{
  const armor=Object.fromEntries(['helmet','chestplate','leggings','boots'].map((part,i)=>[part,{name:'iron_'+part,count:1,slot:5+i}]));
  const result=estimateEarlySurvivalProgress({environment:{status:{pos:[0,64,0]},inventory:{items:[{name:'diamond_pickaxe',count:1,slot:23},{name:'diamond',count:16,slot:24}],armor}}});
  assert.deepEqual(result.diamondBudget,{total:31,craftedCredit:3,loose:16,missing:12});
  assert.match(result.phases.find(p=>p.id==='diamond-resources').evidence,/护甲0\/24、镐3\/3/);
});

test('ledger-completed stages remain visible as historical when current inventory contradicts them',()=>{
  const result=estimateEarlySurvivalProgress({environment:{status:{pos:[0,87,0]},inventory:{items:[]}},progressLedger:{completed:[0,1,2,3,4]}});
  assert.equal(result.phases[0].status,'done');
  assert.equal(result.phases[0].progressSource,'history');
  assert.match(result.phases[0].evidence,/历史进度已确认；当前观察：0 个原木/);
  assert.equal(result.phases[5].status,'active');
  assert.equal(result.phases[5].progressSource,'pending');
});
