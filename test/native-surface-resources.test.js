import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {NativeBridge} from '../src/native/bridge.js';

function world({canes=[],animal=null,hidden=false,adjacentWater=false,malformed=false}={}){
  const plants=new Map(canes.map(p=>[p.join(','),p])),digs=[],moves=[],queries=[],controls=[],progress=[];
  let pos=[.5,63,.5],cane=0,leather=0,alive=Boolean(animal),failed=false;
  const stock=()=>[{name:'iron_sword',count:1,slot:36},...(cane?[{name:'sugar_cane',count:cane}]:[]),...(leather?[{name:'leather',count:leather}]:[])];
  const block=p=>plants.has(p.join(','))?'sugar_cane':adjacentWater&&p[0]===2&&p[1]===64&&p[2]===0?'water':p[1]<63?'sand':'air';
  const api={async request(url,{body={}}={}){
    if(url==='/status')return {ok:true,result:{pos,alive:true,ready:true,on_ground:true,health:20,food:20,dimension:'overworld',xp_level:30,held:{name:'iron_sword',slot:36}}};
    if(url==='/inventory')return {ok:true,result:{items:stock(),armor:{},empty_slots:30}};
    if(url==='/get_block')return {ok:true,result:{name:block(body.pos),diggable:true}};
    if(url==='/find_blocks'){queries.push(body);return {ok:true,result:{blocks:malformed?{}:[...plants.values()].map(p=>({name:'sugar_cane',pos:p})).reverse()}};}
    if(url==='/dig'){
      if(hidden&&!failed&&pos[0]<1){failed=true;return {ok:false,error:{code:'not_visible',message:'hidden from this face'}};}
      assert.equal(block(body.pos),'sugar_cane');assert.equal(block([body.pos[0],body.pos[1]-1,body.pos[2]]),'sugar_cane','root must remain');
      digs.push([...body.pos]);for(const [key,p]of [...plants])if(p[0]===body.pos[0]&&p[2]===body.pos[2]&&p[1]>=body.pos[1]){plants.delete(key);cane++;}return {ok:true,result:{}};
    }
    if(url==='/move_to'){assert.notEqual(block([Math.floor(body.x),Math.floor(body.y)-1,Math.floor(body.z)]),'sugar_cane');pos=[body.x,body.y,body.z];moves.push([...pos]);return {ok:true,result:{}};}
    if(url==='/get_entities'){
      queries.push(body);let entities=[];
      if(alive&&animal&&body.types.some(t=>t==='animal'||t===animal.name))entities=[{id:90,type:'animal',name:animal.name,pos:[2.5,63,.5],visible:true,...animal}];
      return {ok:true,result:{entities}};
    }
    if(url==='/posture')return {ok:true,result:{}};
    if(url==='/control'){controls.push(body);if(body.hit){assert.ok(Number.isFinite(body.yaw)&&Number.isFinite(body.pitch));alive=false;leather+=2;return {ok:true,result:{hits:[{entity:{id:90}}]}};}return {ok:true,result:{}};}
    throw new Error(url+' '+JSON.stringify(body));
  }};
  return {api,digs,moves,queries,controls,progress,plants,get cane(){return cane},get leather(){return leather}};
}
async function run(w,targets,saved={}){
  const dir=await mkdtemp(path.join(os.tmpdir(),'mc-surface-resources-')),stateFile=path.join(dir,'state.json');
  await writeFile(stateFile,JSON.stringify(saved));const bridge=new NativeBridge({api:w.api,stateFile,executable:process.env.NATIVE_TEST_EXE});
  try{return await bridge.run('gather_resources',{surveyId:'test-surface',maxNodes:1,targets},{onProgress:p=>w.progress.push(p)}).promise;}
  finally{bridge.close();await rm(dir,{recursive:true,force:true});}
}
test('nearby cane is harvested before exploration at the actual Y63 shoreline, leaving roots',async()=>{
  const w=world({canes:[[1,63,0],[1,64,0],[1,65,0]]});const out=await run(w,[{item:'sugar_cane',count:2}]);
  assert.equal(out.result.stopReason,'target_reached');assert.equal(w.cane,2);assert.deepEqual(w.digs,[[1,64,0]]);assert.equal(w.plants.has('1,63,0'),true);assert.equal(w.moves.length,0);
});
test('unsorted search results still select the nearest mature cane column first',async()=>{
  const w=world({canes:[[1,63,0],[1,64,0],[8,63,0],[8,64,0]]});await run(w,[{item:'sugar_cane',count:1}]);assert.deepEqual(w.digs,[[1,64,0]]);assert.equal(w.moves.length,0);
});
test('a distant local cane patch is harvested without returning to the obsolete survey node',async()=>{
  const w=world({canes:[[6,63,0],[6,64,0]]});const out=await run(w,[{item:'sugar_cane',count:1}]);
  assert.equal(out.result.stopReason,'target_reached');assert.equal(w.cane,1);assert.ok(w.moves.length>0);assert.ok(w.moves.at(-1)[0]>1);assert.ok(w.moves.every(p=>p[1]===63));
});
test('surface cane ignores old permanent unreachable marks and retries current geometry',async()=>{
  const w=world({canes:[[1,63,0],[1,64,0]]});await run(w,[{item:'sugar_cane',count:1}],{resourceSurveys:{'test-surface':{entry:[0,63,0],dimension:'overworld',nodes:{'[0,63,0]':{resourcesSkipped:{'[1,63,0]':'unreachable','[1,64,0]':'unreachable'}}},visitedCells:{},stack:[],runs:[]}}});assert.equal(w.cane,1);
});
test('single-height cane is left growing rather than dug at its root',async()=>{
  const w=world({canes:[[1,63,0]]});const out=await run(w,[{item:'sugar_cane',count:1}]);assert.equal(w.digs.length,0);assert.equal(out.state.resourceSurveys['test-surface'].resourceTargets['[1,63,0]'].status,'growing');
});
test('plant harvesting does not falsely reject water beside a non-solid upper segment',async()=>{
  const w=world({canes:[[1,63,0],[1,64,0]],adjacentWater:true});await run(w,[{item:'sugar_cane',count:1}]);assert.equal(w.cane,1);
});
test('cane hidden from one face is harvested after moving to another supported position',async()=>{
  const w=world({canes:[[1,63,0],[1,64,0]],hidden:true});await run(w,[{item:'sugar_cane',count:1}]);assert.equal(w.cane,1);assert.ok(w.moves.length>0);
});
test('malformed targeted block response fails explicitly rather than pretending no resource exists',async()=>{
  const w=world({malformed:true});await assert.rejects(run(w,[{item:'sugar_cane',count:1}]),e=>e.code==='protocol_error');
});
for(const name of ['cow','horse','mooshroom','donkey','mule'])test('leather output maps to '+name+' entities with current-angle attacks',async()=>{
  const w=world({animal:{name}});const out=await run(w,[{item:'leather',count:2}]);assert.equal(out.result.stopReason,'target_reached');assert.equal(w.leather,2);assert.ok(w.controls.some(c=>c.hit));assert.ok(w.queries.some(q=>q.types.includes(name)));assert.ok(w.queries.every(q=>!q.types.includes('leather')));
});
for(const attributes of [{name:'horse',tamed:true},{name:'cow',is_baby:true},{name:'horse',owner:'someone'},{name:'horse',custom_name:'named animal'}])test('leather collection preserves '+JSON.stringify(attributes),async()=>{
  const w=world({animal:attributes});await run(w,[{item:'leather',count:2}]);assert.equal(w.controls.some(c=>c.hit),false);assert.equal(w.leather,0);
});
