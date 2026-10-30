import {expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {readFileSync} from 'node:fs';
import {applyFinalSchema} from './fixtures/migrations.ts';
import {sqliteD1} from './fixtures/sqlite-d1.ts';
import {withBuildTaskDeadline} from '../apps/app/src/server/task-deadlines.ts';
import {currentBuildTask,effectiveBuildSignal} from '../apps/app/src/server/task-deadline-context.ts';
function world(){const sqlite=new Database(':memory:');applyFinalSchema(sqlite);return {sqlite,db:sqliteD1(sqlite)};}
test('a hanging delegate settles and aborts the actual propagated signal',async()=>{
 const {sqlite,db}=world();try {
  let cancelled=false,expired=0;
  await expect(withBuildTaskDeadline({db,runId:'r',admissionId:'payer',taskKey:'hang',parentDeadlineAt:Date.now()+1000,allowanceMs:10,onTimeout:async()=>{expired++;}},async()=>{
   const signal=effectiveBuildSignal()!;
   return await new Promise<never>((_,reject)=>signal.addEventListener('abort',()=>{cancelled=true;reject(signal.reason);},{once:true}));
  })).rejects.toThrow('SPECIALIST_DEADLINE_EXHAUSTED');
  expect(cancelled).toBe(true);expect(expired).toBe(1);
 }finally{sqlite.close();}
});
test('reconstruction does not refresh a task deadline or accept a new admission',async()=>{
 const {sqlite,db}=world();try {
  const input={db,runId:'r',admissionId:'payer',taskKey:'repeat',parentDeadlineAt:Date.now()+1000,allowanceMs:100};
  const first=await withBuildTaskDeadline(input,async()=>currentBuildTask()!.deadlineAt);
  const restored=await withBuildTaskDeadline({...input,db:sqliteD1(sqlite),allowanceMs:10000},async()=>currentBuildTask()!.deadlineAt);
  expect(restored).toBe(first);
  await expect(withBuildTaskDeadline({...input,admissionId:'new-payer'},async()=>true)).rejects.toThrow('STALE_BUILD_TASK');
  sqlite.prepare('update build_task_deadlines set deadlineAt=?').run(Date.now()-1);
  let called=false;await expect(withBuildTaskDeadline(input,async()=>{called=true;})).rejects.toThrow();expect(called).toBe(false);
 }finally{sqlite.close();}
});
test('a child delegate cannot outlive its parent deadline',async()=>{
 const {sqlite,db}=world();try {
  const parent=Date.now()+500;
  const deadline=await withBuildTaskDeadline({db,runId:'r',admissionId:'payer',taskKey:'child',parentDeadlineAt:parent,allowanceMs:10000},async()=>currentBuildTask()!.deadlineAt);
  expect(deadline).toBe(parent);
 }finally{sqlite.close();}
});
