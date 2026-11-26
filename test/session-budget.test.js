import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionBudget } from '../src/llm/session-budget.js';

test('all-layer reservations survive restart, unknown billing and a hard limit',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mc-budget-'));
 try{
  const opts={sessionFile:path.join(dir,'session.json'),ledgerFile:path.join(dir,'ledger.json'),now:()=>5000};
  const session={active:true,startedAt:1000,deadline:10000,tokenBudget:{input:8000,output:100}};fs.writeFileSync(opts.sessionFile,JSON.stringify(session));
  const a=new SessionBudget(opts),b=new SessionBudget(opts),t=a.reserve('distribution',[],40);
  b.reserve('reflection',[],40);
  assert.throws(()=>a.reserve('tac',[],21),{code:'llm_budget_exhausted'});
  b.settle(t,{prompt_tokens:100,completion_tokens:10});
  const ledger=a.read(session);assert.equal(ledger.input,100);assert.equal(ledger.output,10);assert.equal(Object.keys(ledger.reservations).length,1);assert.equal(ledger.byLayer.distribution.requests,1);
  b.settle(t,{prompt_tokens:100,completion_tokens:10});assert.equal(a.read(session).input,100);
  const unknown=b.reserve('tac',[],20);b.settle(unknown,null);assert.equal(Object.keys(a.read(session).reservations).length,2);
  fs.writeFileSync(opts.sessionFile,JSON.stringify({...session,active:false}));assert.throws(()=>a.reserve('distribution',[],1),{code:'llm_budget_exhausted'});
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
