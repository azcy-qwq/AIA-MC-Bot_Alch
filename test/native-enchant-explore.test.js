import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {NativeBridge} from '../src/native/bridge.js';
async function scenario(api,run,saved={}){const dir=await mkdtemp(path.join(os.tmpdir(),'mc-enchant-'));const bridge=new NativeBridge({api,stateFile:path.join(dir,'state.json'),executable:process.env.NATIVE_TEST_EXE});await writeFile(bridge.stateFile,JSON.stringify(saved));try{await run(bridge);}finally{bridge.close();await rm(dir,{recursive:true,force:true});}}
test('build enchanting area reuses a nearby table and reports existing shelves',async()=>{
 const calls=[];const api={async request(url,{body={}}={}){
  calls.push({url,body});
  if(url==='/status')return {ok:true,result:{pos:[0.5,64,0.5],alive:true,ready:true,health:20,food:20,dimension:'overworld'}};
  if(url==='/inventory')return {ok:true,result:{items:[],armor:{},empty_slots:36}};
  if(url==='/find_blocks')return {ok:true,result:{blocks:body.types?.[0]==='enchanting_table'?[{name:'enchanting_table',pos:[6,64,0]}]:[{name:'bookshelf',pos:[5,64,0]},{name:'bookshelf',pos:[7,64,0]},{name:'bookshelf',pos:[6,64,1]}]}};
  throw new Error(url);
 }};
 await scenario(api,async b=>{const out=await b.run('build_enchanting_area',{bookshelves:15}).promise;assert.equal(out.result.reused,true);assert.equal(out.result.bookshelves,3);assert.equal(calls.filter(c=>c.url==='/find_blocks').length,2);});
});
test('enchanting orders pick then sword then armor, re-equips armor, and resumes from actual enchantments',async()=>{
 const names=['diamond_pickaxe','diamond_sword','diamond_helmet','diamond_chestplate','diamond_leggings','diamond_boots'];const slots=['head','chest','legs','feet'];let stock=names.slice(0,2).map(name=>({name,count:1}));stock.push({name:'lapis_lazuli',count:121});const armor=Object.fromEntries(slots.map((slot,i)=>[slot,{name:names[i+2],count:1}]));for(const n of names.slice(2))stock.push({name:n.replace('diamond','iron'),count:1});const acts=[];let xp=60,held=null;
 const api={async request(url,{body={}}={}){if(url==='/status')return {ok:true,result:{pos:[.5,64,.5],alive:true,ready:true,health:20,xp_level:xp,held,dimension:'overworld'}};
 if(url==='/inventory')return {ok:true,result:{items:structuredClone(stock),armor:structuredClone(armor),empty_slots:20}};
 if(url==='/get_block')return {ok:true,result:{name:body.pos.join(',')==='1,64,0'?'enchanting_table':body.pos[1]<64?'stone':'air'}};
 if(url==='/equip'){let k=body.slot==='torso'?'chest':body.slot;if(k==='hand')held=stock.find(v=>v.name===body.item);else{let i=stock.findIndex(v=>v.name===body.item);assert.ok(i>=0);const [v]=stock.splice(i,1);stock.push(armor[k]);armor[k]=v;}return {ok:true,result:{}};}
 if(url==='/window/act'){assert.deepEqual(body.ops.map(o=>o.op),['put','put','select','take']);const n=body.ops[0].item;assert.equal(body.ops[2].option,2);const item=stock.find(v=>v.name===n);assert.ok(item);assert.ok(!item.enchantments);item.enchantments=[{name:'unbreaking',level:3}];stock.find(v=>v.name==='lapis_lazuli').count-=3;xp-=3;acts.push(n);return {ok:true,result:{}};}throw new Error(url);}};
 await scenario(api,async b=>{let out=await b.run('enchant_equipment',{target:[1,64,0]}).promise;assert.equal(out.result.verified,true);assert.deepEqual(acts,names);assert.ok(Object.values(armor).every(v=>v.name.startsWith('diamond')&&v.enchantments));out=await b.run('enchant_equipment',{target:[1,64,0]}).promise;assert.equal(out.result.verified,true);assert.equal(acts.length,6);});
});
test('a closed cave survey terminates and retains its visited mark on restart',async()=>{
 const api={async request(url,{body={}}={}){if(url==='/status')return {ok:true,result:{pos:[.5,10,.5],alive:true,ready:true,health:20,food:20,dimension:'overworld'}};if(url==='/inventory')return {ok:true,result:{items:[],empty_slots:36}};if(url==='/find_blocks')return {ok:true,result:{blocks:[]}};if(url==='/get_block')return {ok:true,result:{name:body.pos[0]===0&&body.pos[2]===0&&[10,11].includes(body.pos[1])?'air':'stone'}};throw new Error(url);}};
 await scenario(api,async b=>{const first=await b.run('explore_cave',{caveId:'closed',maxNodes:12}).promise;assert.equal(first.result.stopReason,'surveyed_reachable_frontier');assert.equal(first.result.nodesVisited,1);const second=await b.run('explore_cave',{}).promise;assert.equal(second.result.surveyId,'closed');assert.equal(second.result.nodesVisited,1);});
});
test('an adjacent ore with clear headroom is collected by walking into the mined cell', async () => {
  let pos = [.5, 64, .5], mined = false, coal = 0;
  const ore = [1,64,0];
  const held = {name:'stone_pickaxe',slot:36};
  const api = {async request(url, {body = {}} = {}) {
    if (url === '/status') return {ok:true,result:{pos,held,alive:true,ready:true,health:20,food:20,dimension:'overworld'}};
    if (url === '/inventory') return {ok:true,result:{items:[{...held,count:1},{name:'coal',count:coal}],empty_slots:34}};
    if (url === '/get_block') {
      const name = body.pos[1] < 64 ? 'stone' : !mined && body.pos.join() === ore.join() ? 'coal_ore' : 'air';
      return {ok:true,result:{name,diggable:true}};
    }
    if (url === '/find_blocks') return {ok:true,result:{blocks:mined ? [] : [{name:'coal_ore',pos:ore}]}};
    if (url === '/dig') {
      assert.deepEqual(body.pos,ore);
      assert.equal(body.collect,false);
      mined = true;
      return {ok:true,result:{}};
    }
    if (url === '/move_to') {
      pos = [body.x,body.y,body.z];
      if (pos[0] === 1.5 && mined) coal = 1;
      return {ok:true,result:{pos}};
    }
    throw new Error(url);
  }};
  await scenario(api,async bridge => {
    await bridge.run('explore_cave',{targets:[{item:'coal',count:1}]}).promise;
    assert.equal(coal,1);
    assert.deepEqual(pos,[.5,64,.5]);
  });
});
test('ore sweep clears an occluding rock and rescans newly exposed diamonds',async()=>{
 const broken=new Set(),dug=[];let diamonds=0;const key=p=>p.join(',');
 const block=p=>broken.has(key(p))?'air':key(p)==='0,63,0'?'stone':['0,64,1','1,65,0'].includes(key(p))?'stone':['2,64,0','2,64,1'].includes(key(p))?'deepslate_diamond_ore':'air';
 const api={async request(url,{body={}}={}){
  if(url==='/status')return {ok:true,result:{pos:[.5,64,.5],alive:true,ready:true,food:20,health:20,dimension:'overworld',held:{name:'diamond_pickaxe',slot:36}}};
  if(url==='/inventory')return {ok:true,result:{items:[{name:'diamond_pickaxe',count:1,slot:36},{name:'diamond',count:diamonds}],empty_slots:30}};
  if(url==='/get_block')return {ok:true,result:{name:block(body.pos),diggable:true}};
  if(url==='/find_blocks'){const q=!broken.has('2,64,0')?[2,64,0]:!broken.has('2,64,1')?[2,64,1]:null;return {ok:true,result:{blocks:q?[{name:'deepslate_diamond_ore',pos:q}]:[]}};}
  if(url==='/dig'){const k=key(body.pos);if(k==='2,64,0'&&!broken.has('1,65,0'))return {ok:false,error:{code:'out_of_reach',message:'occluded'}};if(block(body.pos)==='deepslate_diamond_ore')diamonds++;dug.push(k);broken.add(k);return {ok:true,result:{}};}
  throw new Error(url);
 }};
 await scenario(api,async b=>{await b.run('explore_cave',{caveId:'occlusion',targets:[{item:'diamond',count:2}]}).promise;assert.equal(diamonds,2);assert.ok(dug.indexOf('1,65,0')<dug.indexOf('2,64,0'));assert.equal(dug.includes('0,63,0'),false);});
});
test('mineral value outweighs a small distance difference',async()=>{
 const mined=[],removed=new Set();let held={name:'diamond_pickaxe',slot:36},pos=[.5,64,.5];
 const ores=[{name:'coal_ore',pos:[1,64,0]},{name:'deepslate_diamond_ore',pos:[2,64,0]}];
 const api={async request(url,{body={}}={}){
  if(url==='/status')return {ok:true,result:{pos,alive:true,ready:true,health:20,food:20,xp_level:30,dimension:'overworld',held}};
  if(url==='/move_to'){pos=[body.x,body.y,body.z];return {ok:true,result:{pos}};}
  if(url==='/inventory')return {ok:true,result:{items:[{...held,count:1},{name:'diamond',count:mined.filter(x=>x.includes('diamond')).length},{name:'coal',count:mined.filter(x=>x==='coal_ore').length}],empty_slots:30}};
  if(url==='/get_block'){const ore=ores.find(v=>v.pos.join(',')===body.pos.join(','));return {ok:true,result:{name:ore&&!removed.has(ore.name)?ore.name:body.pos[1]<64?'stone':'air',diggable:true}};}
  if(url==='/find_blocks')return {ok:true,result:{blocks:ores.filter(o=>!removed.has(o.name))}};
  if(url==='/dig'){const ore=ores.find(o=>o.pos.join(',')===body.pos.join(','));mined.push(ore.name);removed.add(ore.name);return {ok:true,result:{}};}
  throw new Error(url);
 }};
 await scenario(api,async b=>{await b.run('explore_cave',{caveId:'priority',targets:[{item:'diamond',count:1}]}).promise;assert.equal(mined[0],'deepslate_diamond_ore');});
});
test('mine lighting uses a side recess, accepts wall torches, and does not repeat',async()=>{
 let lit=null;const cleared=new Set(),placements=[];let torches=26;
 const api={async request(url,{body={}}={}){
  if(url==='/status')return {ok:true,result:{pos:[.5,64,.5],alive:true,ready:true,health:20,food:20,dimension:'overworld',held:{name:'diamond_pickaxe',slot:36}}};
  if(url==='/inventory')return {ok:true,result:{items:[{name:'diamond_pickaxe',count:1,slot:36},{name:'torch',count:torches}],empty_slots:30}};
  if(url==='/find_blocks')return {ok:true,result:{blocks:[]}};
  if(url==='/get_block'){let k=body.pos.join(',');return {ok:true,result:{name:k===lit?'wall_torch':cleared.has(k)||body.pos[0]===0&&body.pos[2]===0&&[64,65].includes(body.pos[1])?'air':'stone',diggable:true}};}
  if(url==='/dig'){assert.notEqual(body.pos.join(','),'0,63,0');cleared.add(body.pos.join(','));return {ok:true,result:{}};}
  if(url==='/place'){assert.equal(body.item,'torch');assert.notEqual(body.pos[0]+','+body.pos[2],'0,0');lit=body.pos.join(',');placements.push(lit);torches--;return {ok:true,result:{}};}
  throw new Error(url);
 }};
 await scenario(api,async b=>{await b.run('explore_cave',{caveId:'lit'}).promise;await b.run('explore_cave',{caveId:'lit'}).promise;assert.equal(placements.length,1);});
});
test('high ore aligns horizontally, builds a recorded pillar and dismantles only its own blocks',async()=>{
 let pos=[.5,64,.5],diamond=0;const placed=new Map(),removed=[],moves=[];const ore=[1,68,0],key=p=>p.join(',');
 const block=p=>key(p)===key(ore)&&!diamond?'deepslate_diamond_ore':placed.get(key(p))||(key(p)==='0,63,0'?'stone':'air');
 const api={async request(url,{body={}}={}){
  if(url==='/status')return {ok:true,result:{pos,alive:true,ready:true,health:20,food:20,dimension:'overworld',held:{name:'diamond_pickaxe',slot:36}}};
  if(url==='/inventory')return {ok:true,result:{items:[{name:'diamond_pickaxe',count:1,slot:36},{name:'cobblestone',count:64},{name:'diamond',count:diamond}],empty_slots:30}};
  if(url==='/find_blocks')return {ok:true,result:{blocks:diamond?[]:[{name:'deepslate_diamond_ore',pos:ore}]}};
  if(url==='/get_block')return {ok:true,result:{name:block(body.pos),diggable:true}};
  if(url==='/move_to'){pos=[body.x,body.y,body.z];moves.push([...pos]);return {ok:true,result:{}};}
  if(url==='/control'){if(body.jump)pos=[pos[0],Math.floor(pos[1])+1.2,pos[2]];return {ok:true,result:{}};}
  if(url==='/place'){placed.set(key(body.pos),body.item);pos=[body.pos[0]+.5,body.pos[1]+1,body.pos[2]+.5];return {ok:true,result:{}};}
  if(url==='/dig'){if(key(body.pos)===key(ore)){assert.equal(Math.floor(pos[1]),68);assert.equal(body.collect,false);diamond++;}else{assert.ok(placed.has(key(body.pos)));removed.push(key(body.pos));placed.delete(key(body.pos));pos=[body.pos[0]+.5,body.pos[1],body.pos[2]+.5];}return {ok:true,result:{}};}
  if(url==='/get_entities')return {ok:true,result:{entities:[]}};
  throw new Error(url);
 }};
 await scenario(api,async b=>{const out=await b.run('explore_cave',{caveId:'high',targets:[{item:'diamond',count:1}]}).promise;assert.equal(diamond,1);assert.equal(removed.length,4);assert.equal(out.state.oreScaffold.active,false);assert.equal(Math.floor(pos[1]),64);});
});
