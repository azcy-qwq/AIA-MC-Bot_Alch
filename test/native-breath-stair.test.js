import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {NativeBridge} from '../src/native/bridge.js';

async function scenario(api, run, saved = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mc-air-stair-'));
  const stateFile = path.join(dir, 'state.json');
  await writeFile(stateFile, JSON.stringify(saved));
  const bridge = new NativeBridge({api, stateFile, executable: process.env.NATIVE_TEST_EXE});
  try { await run(bridge); } finally { bridge.close(); await rm(dir, {recursive:true, force:true}); }
}

function miningWorld(blockAt, oreList = () => []) {
  const removed = new Set(), placed = new Map(), moves = [], digs = [], placements = [];
  let pos = [.5, 64, .5], diamonds = 0;
  const key = q => q.join(',');
  const block = q => placed.get(key(q)) || (removed.has(key(q)) ? 'air' : blockAt(q));
  const api = {async request(url, {body = {}} = {}) {
    if (url === '/status') return {ok:true,result:{pos,alive:true,ready:true,health:20,food:20,xp_level:30,dimension:'overworld',held:{name:'diamond_pickaxe',slot:38}}};
    if (url === '/inventory') return {ok:true,result:{items:[{name:'diamond_pickaxe',count:1,slot:38},{name:'cobblestone',count:64},{name:'diamond',count:diamonds}],empty_slots:30}};
    if (url === '/get_block') return {ok:true,result:{name:block(body.pos),diggable:true}};
    if (url === '/find_blocks') return {ok:true,result:{blocks:oreList(removed).filter(q=>block(q).endsWith('_ore')).map(q=>({name:block(q),pos:q}))}};
    if (url === '/dig') { if (block(body.pos).includes('diamond_ore')) diamonds++; removed.add(key(body.pos)); digs.push(body.pos); return {ok:true,result:{}}; }
    if (url === '/place') { placed.set(key(body.pos),body.item); placements.push(body.pos); return {ok:true,result:{}}; }
    if (url === '/move_to') {pos=[body.x,body.y,body.z];moves.push(pos);return {ok:true,result:{pos}};}
    throw new Error('Unexpected mining API ' + url);
  }};
  return {api, removed, placements, moves, digs, get diamonds(){return diamonds;}, get pos(){return pos;}};
}

test('upstairs sweeps side diamonds outside the old next-column filter and newly exposed vein blocks', async () => {
  const first=[0,65,2], second=[0,66,2];
  const world=miningWorld(([x,y,z])=>[first,second].some(q=>q.join(',')===[x,y,z].join(','))?'deepslate_diamond_ore':x===0&&z===0&&y>=64||x===0&&z===1&&y===65?'air':'stone',removed=>removed.has(first.join(','))?[second]:[first]);
  await scenario(world.api,async b=>{
    const out=await b.run('staircase_up',{direction:'x',steps:1}).promise;
    assert.equal(world.diamonds,2);assert.deepEqual(world.pos,[1.5,65,.5]);
    assert.ok(world.placements.some(q=>q.join(',')===first.join(',')));
    assert.equal(out.result.warning,undefined);
  });
});

test('upstairs rescans after the step is excavated, before reporting completion', async () => {
  const ore=[2,65,0];
  const world=miningWorld(([x,y,z])=>[x,y,z].join(',')===ore.join(',')?'deepslate_diamond_ore':x===0&&z===0&&y>=64?'air':'stone',removed=>removed.has('1,66,0')?[ore]:[]);
  await scenario(world.api,async b=>{await b.run('staircase_up',{direction:'x',steps:1}).promise;assert.equal(world.diamonds,1);assert.ok(world.digs.findIndex(q=>q.join(',')==='1,66,0')<world.digs.findIndex(q=>q.join(',')===ore.join(',')));});
});

test('existing upstairs uses medium legs while still collecting adjacent diamonds', async () => {
  const ore=[4,68,2];
  const world=miningWorld(([x,y,z])=>[x,y,z].join(',')===ore.join(',')?'deepslate_diamond_ore':y<64+x?'stone':'air',()=>[ore]);
  await scenario(world.api,async b=>{await b.run('staircase_up',{direction:'x',steps:8}).promise;assert.equal(world.diamonds,1);assert.deepEqual(world.pos,[8.5,72,.5]);const stairLegs=world.moves.filter(p=>p[2]===.5&&p[0]>1);assert.equal(stairLegs.length,2);assert.deepEqual(stairLegs[0],[6.5,70,.5]);});
});

test('staircase scans incidental ores periodically instead of before and after every step', async () => {
  const ore = [4, 68, 2];
  const world = miningWorld(([x,y,z]) => [ore].some(q => q.join(',') === [x,y,z].join(',')) ? 'deepslate_diamond_ore' : y < 64 + x ? 'stone' : 'air', () => [ore]);
  await scenario(world.api, async bridge => {
    await bridge.run('staircase_up', { direction: 'x', steps: 8 }).promise;
    assert.equal(world.diamonds, 1);
    assert.deepEqual(world.pos, [8.5, 72, .5]);
  });
});

function swimmingWorld({ceiling=false,trapped=false,capacity=400,plants=false,broad=false,shaft=false,dive=false}={}){
  let pos=[.5,60,.5],oxygen=capacity,jumping=false;const controls=[],postures=[];
  const block=q=>{
    const [x,y,z]=q;
    if(dive)return z===0&&((x===0&&y>=59&&y<=61)||(x===1&&[59,60].includes(y)))?(x===1&&y===60?'air':'water'):'stone';
    if(shaft)return z===0&&((x===0&&[60,61].includes(y))||(x===1&&y>=60))?(x===1&&y>=70?'air':'water'):'stone';
    if(broad)return [60,61].includes(y)&&Math.abs(x)+Math.abs(z)<=6?(x===6&&y===61?'air':'water'):'stone';
    if(!ceiling)return y<60?'stone':y<=62?(plants&&y===62?'seagrass':'water'):'air';
    if(z!==0||x<0||x>2||y<60||y>61)return 'stone';
    if(x===2&&y===61&&!trapped)return 'air';
    return 'water';
  };
  const submerged=()=>['water','seagrass'].includes(block([Math.floor(pos[0]),Math.floor(pos[1])+1,Math.floor(pos[2])]));
  const api={async request(url,{body={}}={}){
    if(url==='/status'){if(!submerged())oxygen=capacity;return {ok:true,result:{pos,alive:true,ready:true,health:20,food:20,dimension:'overworld',oxygen,submerged:submerged(),in_water:true,jumping:false,blocking:false,sneaking:false}};}
    if(url==='/inventory')return {ok:true,result:{items:[{name:'diamond',count:1}],empty_slots:35}};
    if(url==='/get_block')return {ok:true,result:{name:block(body.pos),diggable:true}};
    if(url==='/posture'){postures.push(body);if('jump' in body)jumping=body.jump;return {ok:true,result:{}};}
    if(url==='/control'){
      controls.push(body);
      if(body.forward){const x=pos[0]-Math.sin(body.yaw)*body.ms/1000*2.5,z=pos[2]-Math.cos(body.yaw)*body.ms/1000*2.5;if(block([Math.floor(x),Math.floor(pos[1])+1,Math.floor(z)])!=='stone')pos=[x,pos[1],z];}
      if(body.sneak&&!body.jump&&!jumping&&block([Math.floor(pos[0]),Math.floor(pos[1])-1,Math.floor(pos[2])])!=='stone')pos=[pos[0],pos[1]-1,pos[2]];
      if((body.jump||jumping)&&block([Math.floor(pos[0]),Math.floor(pos[1])+2,Math.floor(pos[2])])!=='stone')pos=[pos[0],pos[1]+1,pos[2]];
      if(submerged())oxygen=Math.max(-1,oxygen-1);
      return {ok:true,result:{pos}};
    }
    throw new Error('Unexpected swimming API '+url);
  }};
  return {api,controls,postures,get pos(){return pos;},submerged};
}

test('water escape floats to open air and verifies breathing',async()=>{
  const w=swimmingWorld();await scenario(w.api,async b=>{const out=await b.run('breathe',{}).promise;assert.equal(w.submerged(),false);assert.equal(out.result.breathing,true);assert.ok(w.controls.every(c=>c.jump));assert.equal(out.state.breathing.lastRecovery.swims,2);assert.equal(out.state.breathing.holdingFloat,true);assert.deepEqual(w.postures.at(-1),{jump:true,sneak:false,shield:false});});
});

test('sealed ceiling routes horizontally to a connected air pocket without a standing floor',async()=>{
  const w=swimmingWorld({ceiling:true,capacity:20});await scenario(w.api,async b=>{const out=await b.run('breathe',{}).promise;assert.equal(w.submerged(),false);assert.equal(Math.floor(w.pos[0]),2);assert.ok(w.controls.some(c=>c.forward));assert.equal(out.result.oxygen,20);});
});

test('water plants remain swimmable while searching for breathable surface air',async()=>{
  const w=swimmingWorld({plants:true});await scenario(w.api,async b=>{const out=await b.run('breathe',{}).promise;assert.equal(w.submerged(),false);assert.equal(out.result.breathing,true);assert.equal(out.state.breathing.lastRecovery.swims,2);});
});

test('solid boundary observations do not exhaust a broad sealed-water search before its air exit',async()=>{
  const w=swimmingWorld({broad:true});await scenario(w.api,async b=>{const out=await b.run('breathe',{}).promise;assert.equal(w.submerged(),false);assert.equal(Math.floor(w.pos[0]),6);assert.equal(out.result.breathing,true);});
});

test('sealed deep water moves into a connected rising column before the distant surface is visible',async()=>{
  const w=swimmingWorld({shaft:true});await scenario(w.api,async b=>{const out=await b.run('breathe',{}).promise;assert.equal(w.submerged(),false);assert.equal(Math.floor(w.pos[0]),1);assert.ok(w.pos[1]>=69);assert.equal(out.result.breathing,true);});
});

test('an air pocket below a ledge releases persistent jump before diving and moving sideways',async()=>{
  const w=swimmingWorld({dive:true});await scenario(w.api,async b=>{const out=await b.run('breathe',{}).promise;assert.equal(w.submerged(),false);assert.equal(Math.floor(w.pos[0]),1);assert.equal(Math.floor(w.pos[1]),59);assert.ok(w.controls.some(c=>c.sneak));assert.equal(out.result.breathing,true);});
});

test('completely enclosed water reports no air route and retains buoyancy instead of sinking after failure',async()=>{
  const w=swimmingWorld({ceiling:true,trapped:true});await scenario(w.api,async b=>{await assert.rejects(b.run('breathe',{}).promise,e=>e.code==='no_air_route');assert.equal(w.submerged(),true);assert.equal(w.controls.length,0);assert.deepEqual(w.postures.at(-1),{jump:true,sneak:false,shield:false});});
});

test('fishbone explores a new side cavern then returns to its original recorded lane',async()=>{
  const world=miningWorld(([x,y,z])=>x===0&&z===0&&y>=64||x===1&&z>=1&&z<=2&&[64,65].includes(y)?'air':'stone');
  await scenario(world.api,async b=>{
    const out=await b.run('fishbone_mine',{laneId:'cave',direction:'x',length:2,branchEvery:3}).promise;
    assert.equal(out.result.stopReason,'lane_complete');const lane=out.state.fishboneRoutes['fishbone:cave'];assert.deepEqual(lane.origin,[0,64,0]);assert.deepEqual(lane.end,[2,64,0]);assert.equal(lane.mainStep,2);assert.equal(lane.mainBlocked,undefined);assert.equal(lane.caveDetour.active,false);assert.ok(Object.keys(out.state.caveSurveys).length>0);assert.ok(world.moves.some(p=>p[2]>1));assert.deepEqual(world.pos,[2.5,64,.5]);assert.ok(world.digs.every(p=>[64,65].includes(p[1])));
  });
});

test('surface gathering performs its own access climb before looking for cane',async()=>{
  const world=miningWorld(([x,y,z])=>(x===0&&z===0&&y>=64)||(x===2&&z===0&&y>=66)?'air':'stone');
  let caneScans=0;const request=world.api.request;
  world.api.request=async(url,options={})=>{if(url==='/find_blocks'&&options.body?.types?.includes('sugar_cane')){if(!caneScans)assert.equal(Math.floor(world.pos[1]),66);caneScans++;}return request(url,options);};
  await scenario(world.api,async b=>{const out=await b.run('gather_resources',{surveyId:'surface',surfaceY:66,targets:[{item:'sugar_cane',count:1}]}).promise;assert.equal(out.result.warning,false);assert.ok(caneScans>0);assert.ok(world.pos[1]>=62);assert.deepEqual(out.state.anchors['地表采集出口'].pos,[2,66,0]);});
});

test('surface access turns around a supply chest without abandoning the resource job',async()=>{
  const chest=[1,65,0];
  const world=miningWorld(([x,y,z])=>[x,y,z].join(',')===chest.join(',')?'chest':(x===0&&z===0&&y>=64)||(x===0&&z===2&&y>=66)?'air':'stone');
  await scenario(world.api,async b=>{
    const out=await b.run('gather_resources',{surveyId:'blocked-exit',surfaceY:66,targets:[{item:'cobblestone',count:1}]}).promise;
    assert.equal(out.result.stopReason,'target_reached');
    assert.deepEqual(world.pos,[.5,66,2.5]);
    assert.ok(!world.digs.some(q=>q.join(',')===chest.join(',')));
    assert.deepEqual(out.state.anchors['地表采集出口'].pos,[0,66,2]);
  });
});

test('field exploration keeps all minerals even with no empty slots and a nearby chest',async()=>{
  const counts={diamond:1,redstone_block:80,lapis_lazuli:121,raw_gold:17};let stored=false;const transfers=[];
  const api={async request(url,{body={}}={}){
    if(url==='/status')return {ok:true,result:{pos:[.5,64,.5],alive:true,ready:true,health:20,food:20,dimension:'overworld'}};
    if(url==='/inventory')return {ok:true,result:{items:Object.entries(counts).filter(([,count])=>count>0).map(([name,count])=>({name,count})),empty_slots:stored?6:0}};
    if(url==='/get_block')return {ok:true,result:{name:body.pos.join(',')==='1,64,0'?'chest':body.pos[1]<64?'stone':'air'}};
    if(url==='/window/view')return {ok:true,result:{sections:{container:[]}}};
    if(url==='/window/act'){for(const op of body.ops){assert.equal(op.op,'put');assert.equal(op.to,'container');counts[op.item]-=op.count;transfers.push(op);}stored=true;return {ok:true,result:{}};}
    throw new Error('Unexpected storage API '+url);
  }};
  await scenario(api,async b=>{const out=await b.run('explore_cave',{caveId:'supply',targets:[{item:'diamond',count:1}]}).promise;assert.equal(out.result.stopReason,'target_reached');assert.equal(counts.diamond,1);assert.equal(counts.lapis_lazuli,121);assert.equal(counts.redstone_block,80);assert.equal(counts.raw_gold,17);assert.equal(transfers.length,0);assert.equal(out.state.supplyCaches,undefined);},{facilityCache:{'overworld:chest':[1,64,0]}});
});

test('native inventory quick reference deducts worn armor and deduplicates the hand slot',async()=>{
  await scenario({async request(){throw new Error('Inventory brief must not call HTTP');}},async b=>{
    const armor=Object.fromEntries(['helmet','chestplate','leggings','boots'].map((kind,i)=>[kind,{name:'diamond_'+kind,count:1,slot:5+i}]));
    const out=await b.run('inventory_brief',{inventory:{items:[{name:'diamond_pickaxe',count:1,slot:38},{name:'diamond',count:4,slot:24}],held:{name:'diamond',count:4,slot:24},armor}}).promise;
    assert.deepEqual(out.result.diamondBudget,{total:31,craftedCredit:27,loose:4,missing:0});
  });
});

const ironArmor=Object.fromEntries(['head','chest','legs','feet'].map((slot,i)=>[slot,{name:['iron_helmet','diamond_chestplate','iron_leggings','netherite_boots'][i],count:1,slot:5+i}]));
function withArmor(world){const request=world.api.request;world.api.request=async(url,options)=>{const out=await request(url,options);if(url==='/inventory')out.result.armor=ironArmor;return out;};return world;}

test('iron or better armor overrides a stale avoidCaves flag and resumes the same lane',async()=>{
  const world=withArmor(miningWorld(([x,y,z])=>x===0&&z===0&&y>=64||x===1&&z>=1&&z<=2&&[64,65].includes(y)?'air':'stone'));
  await scenario(world.api,async b=>{const out=await b.run('fishbone_mine',{laneId:'armored',direction:'x',length:2,branchEvery:3,avoidCaves:true}).promise;const lane=out.state.fishboneRoutes['fishbone:armored'];assert.equal(out.result.stopReason,'lane_complete');assert.equal(lane.caveDetour.active,false);assert.equal(lane.mainStep,2);assert.ok(world.moves.some(p=>p[2]>1));assert.deepEqual(world.pos,[2.5,64,.5]);});
});

test('armored staircase enters an accessible cavern and then returns to its construction checkpoint',async()=>{
  const world=withArmor(miningWorld(([x,y,z])=>x===0&&z===0&&y>=64||x===1&&z>=1&&z<=2&&[65,66].includes(y)?'air':'stone'));
  await scenario(world.api,async b=>{const out=await b.run('staircase_up',{direction:'x',steps:1,allowOpenSpace:false}).promise;assert.equal(out.state.constructionCaveDetour.active,false);assert.equal(out.state.constructionCaveDetour.source,'staircase_up');assert.ok(world.moves.some(p=>p[2]>1));assert.deepEqual(world.pos,[1.5,65,.5]);});
});

test('cave exploration follows dry cells next to water without entering or digging the water',async()=>{
  const world=miningWorld(([x,y,z])=>x>=0&&x<=2&&z===0&&[64,65].includes(y)?'air':x>=0&&x<=2&&z===1&&y===64?'water':'stone');
  await scenario(world.api,async b=>{const out=await b.run('explore_cave',{caveId:'waterside',maxNodes:8}).promise;assert.equal(out.result.stopReason,'surveyed_reachable_frontier');assert.ok(world.moves.some(p=>p[0]===2.5));assert.ok(world.moves.every(p=>p[2]===.5));assert.equal(world.digs.length,0);});
});

test('excavation near liquid keeps its separating block rather than rejecting a larger buffer',async()=>{
  const world=miningWorld(([x,y,z])=>x===0&&z===0&&y>=64?'air':x===1&&y===65&&z===2?'lava':'stone');
  await scenario(world.api,async b=>{await b.run('staircase_up',{direction:'x',steps:1}).promise;assert.deepEqual(world.pos,[1.5,65,.5]);assert.ok(!world.digs.some(q=>q.join(',')==='1,65,1'));});
  const blocked=miningWorld(([x,y,z])=>x===0&&z===0&&y>=64?'air':x===1&&y===65&&z===1?'water':'stone');
  await scenario(blocked.api,async b=>{await assert.rejects(b.run('staircase_up',{direction:'x',steps:1}).promise,e=>e.code==='unsafe_excavation');assert.ok(!blocked.digs.some(q=>q.join(',')==='1,65,0'));});
});

test('store without a designated base never uses an incidental chest or creates a new one',async()=>{
  const world=miningWorld(([,y])=>y<64?'stone':'air');
  await scenario(world.api,async b=>{const out=await b.run('workshop',{mode:'store',items:[{item:'cobblestone',count:1}]}).promise;assert.equal(out.result.warning,true);assert.equal(out.result.code,'missing_facility');assert.equal(world.placements.length,0);},{facilityCache:{'overworld:chest':[1,64,0]}});
});

test('surface access changes heading locally when a cut would breach water',async()=>{
  const world=miningWorld(([x,y,z])=>x===0&&z===0&&y>=64||x===0&&z===-2&&y>=66?'air':x===1&&z===1&&y===65?'water':'stone');
  await scenario(world.api,async b=>{const out=await b.run('gather_resources',{surveyId:'water-boundary',surfaceY:66,targets:[{item:'cobblestone',count:1}]}).promise;assert.equal(out.result.stopReason,'target_reached');assert.deepEqual(world.pos,[.5,66,-1.5]);assert.ok(!world.digs.some(q=>q.join(',')==='1,65,1'));});
});

test('surface gathering continues below a tree canopy instead of requesting another exit',async()=>{
  const w=miningWorld(([,y])=>y<64?'grass_block':y===66||y===67?'birch_leaves':'air');
  await scenario(w.api,async b=>{const out=await b.run('gather_resources',{surveyId:'canopy',targets:[{item:'cobblestone',count:1}]}).promise;assert.equal(out.result.stopReason,'target_reached');assert.equal(out.result.warning,false);assert.ok(out.state.anchors['地表采集出口']);assert.equal(w.digs.length,0);});
});
test('a solid roof still cannot be mistaken for open surface under a canopy',async()=>{
  const w=miningWorld(([,y])=>y<64?'grass_block':y===66?'stone':'air');
  await scenario(w.api,async b=>{const out=await b.run('gather_resources',{surveyId:'roof',targets:[{item:'cobblestone',count:1}]}).promise;assert.equal(out.result.code,'surface_access_blocked');assert.equal(out.result.warning,true);assert.equal(w.digs.length,0);});
});
