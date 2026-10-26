import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {readFileSync} from 'node:fs';
import {bootRaw,init,Coordinator,type FlueInstrumentation} from '../apps/app/test-support/spend-harness.ts';
import {sqliteD1} from './fixtures/sqlite-d1.ts';
import {makeTaskDeadlineInstrumentation} from '../apps/app/src/server/task-deadlines.ts';
import {currentBuildTask,effectiveBuildSignal} from '../apps/app/src/server/task-deadline-context.ts';
test('real Flue task interceptor carries the persisted deadline into delegate execution and aborts actual downstream work',async()=>{
 const sqlite=new Database(':memory:');const db=sqliteD1(sqlite);let cancelled=false,seen=false;
 sqlite.exec(`create table build_workflows(conversationId text,runId text,projectId text,spendPayerId text,phase text);`);
 sqlite.exec(readFileSync(new URL('../apps/app/migrations/0053_task_deadlines.sql',import.meta.url),'utf8'));
 sqlite.prepare('insert into build_workflows values(?,?,?,?,?)').run('deadline-runtime','r','p',`build:p:${Date.now()-3_600_000+2000}`,'building');
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
