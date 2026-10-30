import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {readFileSync} from 'node:fs';
import {bootRaw,init,Coordinator,type FlueInstrumentation} from '../apps/app/test-support/spend-harness.ts';
import {sqliteD1} from './fixtures/sqlite-d1.ts';
import {applyFinalSchema} from './fixtures/migrations.ts';
import {makeTaskDeadlineInstrumentation} from '../apps/app/src/server/task-deadlines.ts';
import {currentBuildTask,effectiveBuildSignal} from '../apps/app/src/server/task-deadline-context.ts';
test('real Flue task interceptor carries the persisted deadline into delegate execution and aborts actual downstream work',async()=>{
 const sqlite=new Database(':memory:');const db=sqliteD1(sqlite);let cancelled=false,seen=false;
 sqlite.exec(`create table build_workflows(conversationId text,runId text,projectId text,spendPayerId text,phase text);`);
 applyFinalSchema(sqlite);
 sqlite.prepare('insert into build_workflows(conversationId,runId,projectId,spendPayerId,phase) values(?,?,?,?,?)').run('deadline-runtime','r','p',`build:p:${Date.now()-3_600_000+2000}`,'building');
 const deadline=makeTaskDeadlineInstrumentation({resolve:()=>db});
 const instrumentation:FlueInstrumentation={observe(){},dispose(){},interceptor(operation,context,next){return deadline.interceptor!(operation,context,async()=>{
  if(operation.type==='model'&&currentBuildTask()) {
   seen=true;const signal=effectiveBuildSignal()!;
   return await new Promise<never>((_,reject)=>signal.addEventListener('abort',()=>{cancelled=true;reject(signal.reason);},{once:true}));
  }
  return next();
 });}};
 const boot=await bootRaw({instrumentation,script:[{toolCall:{id:'delegate-timeout',name:'task',arguments:{agent:'delegate',prompt:'work'}},input:1,output:1},{text:'unused',input:1,output:1},{text:'recovered',input:1,output:1}]});
 try {
  const c=init(Coordinator,{id:'deadline-runtime'});await c.read(await c.dispatch('go')).catch(()=>{});
  expect(seen).toBe(true);expect(cancelled).toBe(true);
  expect((sqlite.query('select count(*) n from build_task_deadlines').get() as {n:number}).n).toBeGreaterThan(0);
 }finally{await boot.stop();sqlite.close();}
},15000);

test('the production coordinator retains Flue’s first-statement agent directive',()=>{
 const source=readFileSync(new URL('../apps/app/src/agents/coordinator.ts',import.meta.url),'utf8');
 expect(source.trimStart().startsWith('"use agent";')).toBe(true);
});
test('open delegates hand off after two checked failures: MiniMax to DeepSeek, under one payer',async()=>{
 const {checkLiveRepairRouting}=await import('../apps/app/test-support/repair-routing-harness.ts');
 const sqlite=new Database(':memory:');const db=sqliteD1(sqlite);const payer=`build:p:${Date.now()}`;
 sqlite.exec("create table projects(id text primary key);insert into projects values('p');create table build_workflows(conversationId text,projectId text,runId text,planId text,spendPayerId text,phase text);create table build_features(runId text,planId text,featureId text,status text,position integer);insert into build_features values('r','plan','f','building',1);");
 sqlite.prepare('insert into build_workflows values(?,?,?,?,?,?)').run('live-repair-routing','p','r','plan',payer,'building');
 applyFinalSchema(sqlite);
 sqlite.exec("update build_workflows set repairPolicyVersion='repair-v1'");
 try{const result=await checkLiveRepairRouting(db,'r',payer);expect(result.failures).toBe(4);expect(result.physicalCalls).toBe(11);expect(result.calls).toContain('deepseek-ai/DeepSeek-V4.1-Flash-1017');expect(result.calls).toContain('nvidia/Nemotron-3.5-Super-VL');expect(result.calls).not.toContain('zai-org/GLM-5.3');expect((sqlite.query('select spendPayerId from build_workflows').get() as any).spendPayerId).toBe(payer);}finally{sqlite.close();}
},15000);
test('module delegate deadlines resolve the shared admission and its own feature scope; a stopped module is fenced',async()=>{
 const sqlite=new Database(':memory:');const db=sqliteD1(sqlite);const payer=`build:p:${Date.now()}`;
 const block=JSON.parse(readFileSync(new URL('./fixtures/architecture/farm-block.json',import.meta.url),'utf8'));
 const route=block.routes.find((route:any)=>route.feature&&route.module!=='core');expect(route).toBeTruthy();const instance=`p:1:${route.module}`;
 sqlite.exec("create table projects(id text primary key);insert into projects values('p');create table build_workflows(conversationId text,projectId text,runId text,planId text,approvedDesignRevisionId text,spendPayerId text,phase text);create table build_features(runId text,planId text,featureId text,status text,position integer);create table build_modules(projectId text,buildSeq integer,moduleId text,status text,payerId text);create table plan_doc_revisions(id text,projectId text,body text);");
 sqlite.prepare('insert into build_workflows values(?,?,?,?,?,?,?)').run('root','p','r','plan','design',payer,'building');sqlite.prepare('insert into build_modules values(?,?,?,?,?)').run('p',1,route.module,'building',payer);sqlite.prepare('insert into build_features values(?,?,?,?,?)').run('r','plan',route.feature,'building',1);sqlite.prepare('insert into plan_doc_revisions values(?,?,?)').run('design','p','```caddie-architecture\n'+JSON.stringify(block)+'\n```');
 applyFinalSchema(sqlite);sqlite.exec("update build_workflows set repairPolicyVersion='repair-v1'");
 const instrument=makeTaskDeadlineInstrumentation({resolve:()=>db});const ctx={instanceId:instance,conversationId:'module-child',submissionId:'s'};
 try{await instrument.interceptor!({type:'task',taskId:'module-task'},ctx,async()=>{expect(currentBuildTask()?.runId).toBe('r');expect(currentBuildTask()?.featureIds).toContain(route.feature);sqlite.exec("update build_modules set status='stopped'");await expect(instrument.interceptor!({type:'model',turnId:'late'},ctx,async()=>true)).rejects.toThrow('BUILD_STOPPED');});}finally{sqlite.close();}
});
