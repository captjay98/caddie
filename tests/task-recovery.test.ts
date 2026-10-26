import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {readFileSync} from 'node:fs';
import {sqliteD1} from './fixtures/sqlite-d1.ts';
import {recoverTimedOutTask} from '../apps/app/src/server/task-recovery.ts';
function world(){const sqlite=new Database(':memory:');const payer=`build:p:${Date.now()}`;
 sqlite.exec(`create table projects(id text primary key);insert into projects values('p');
 create table build_workflows(projectId text,runId text,planId text,spendPayerId text,phase text,detail text,updatedAt text);
 create table build_features(runId text,planId text,featureId text,status text,position integer);insert into build_features values('r','plan','f','building',1);
 create table external_operations(runId text,operationKey text,status text);create table sandbox_bindings(runId text,kind text,recordJson text,updatedAt text,sessionId text);`);
 sqlite.prepare('insert into build_workflows values(?,?,?,?,?,?,?)').run('p','r','plan',payer,'building',null,'now');
 sqlite.exec(readFileSync(new URL('../apps/app/migrations/0048_repair_escalation.sql',import.meta.url),'utf8'));sqlite.exec("update build_workflows set repairPolicyVersion='repair-v1'");
 return {sqlite,db:sqliteD1(sqlite),input:{projectId:'p',runId:'r',admissionId:payer,taskKey:'one'}};}
test('safe timeout escalates automatically inside one payer; replay does not add failures',async()=>{
 const {sqlite,db,input}=world();try{
  expect((await recoverTimedOutTask(db,input)).action).toBe('retry-current-feature');await recoverTimedOutTask(db,input);
  expect((sqlite.query('select failures from build_repair_issues').get() as any).failures).toBe(1);
  expect((await recoverTimedOutTask(db,{...input,taskKey:'two'})).routeId).toBe('deepseek-v4.1-flash-1017');
  expect((sqlite.query('select spendPayerId from build_workflows').get() as any).spendPayerId).toBe(input.admissionId);
 }finally{sqlite.close();}
});
test('ambiguous write reconciles the original operation; unknown blocks new writers and stale timeouts cannot block new admission',async()=>{
 for(const state of ['succeeded','unknown']){const {sqlite,db,input}=world();try{
  sqlite.prepare('insert into sandbox_bindings(runId,kind,recordJson,updatedAt) values(?,?,?,?)').run('r','operation',JSON.stringify({state:'ambiguous',operationKey:'original'}),'now');
  let key='';const result=await recoverTimedOutTask(db,input,async original=>{key=original;return {state};});expect(key).toBe('original');expect(result.action).toBe(state==='succeeded'?'retry-current-feature':'stop');
  sqlite.exec("update build_workflows set phase='building',spendPayerId='new'");await recoverTimedOutTask(db,input);expect((sqlite.query('select phase from build_workflows').get() as any).phase).toBe('building');
 }finally{sqlite.close();}}
});

test('module timeouts spend the owning feature episode and ignore another module’s live writer',async()=>{
 const {sqlite,db,input}=world();try{
  sqlite.exec("insert into build_features values('r','plan','other','building',2)");
  sqlite.prepare('insert into sandbox_bindings values(?,?,?,?,?)').run('r','operation',JSON.stringify({state:'dispatched',operationKey:'other-module'}),'now','module:r:other');
  const result=await recoverTimedOutTask(db,{...input,featureIds:['other'],sessionId:'module:r:mine'});expect(result.action).toBe('retry-current-feature');
  expect((sqlite.query('select featureId from build_repair_issues').get() as any).featureId).toBe('other');
 }finally{sqlite.close();}
});
