import {createHash} from 'node:crypto';
import type {FlueInstrumentation} from '@flue/runtime';
import type {D1Database} from './auth.ts';
import {buildTaskDeadlines,currentBuildTask} from './task-deadline-context.ts';
import {buildAttemptAdmittedAt,DEADLINE_POLICY} from './build-deadlines.ts';
export async function withBuildTaskDeadline<T>(input:{db:D1Database;runId:string;admissionId:string;taskKey:string;parentDeadlineAt:number;allowanceMs?:number;onTimeout?:()=>Promise<void>},next:()=>Promise<T>):Promise<T> {
 const stamp=Date.now();const proposed=Math.min(input.parentDeadlineAt,stamp+(input.allowanceMs??DEADLINE_POLICY.specialistMs));
 await input.db.prepare('insert or ignore into build_task_deadlines(taskKey,runId,admissionId,startedAt,deadlineAt) values(?,?,?,?,?)')
  .bind(input.taskKey,input.runId,input.admissionId,stamp,proposed).run();
 const row=(await input.db.prepare('select * from build_task_deadlines where taskKey=?').bind(input.taskKey).all<{runId:string;admissionId:string;deadlineAt:number}>()).results[0]!;
 if(row.runId!==input.runId||row.admissionId!==input.admissionId)throw new Error('STALE_BUILD_TASK');
 const controller=new AbortController();
 const parent=currentBuildTask();const abortParent=()=>controller.abort(parent?.signal.reason);
 parent?.signal.addEventListener('abort',abortParent,{once:true});if(parent?.signal.aborted)abortParent();
 const remaining=Math.min(row.deadlineAt,input.parentDeadlineAt)-Date.now();
 let timer:ReturnType<typeof setTimeout>|undefined;
 if(remaining<=0)controller.abort(new Error('SPECIALIST_DEADLINE_EXHAUSTED'));
 else timer=setTimeout(()=>controller.abort(new Error('SPECIALIST_DEADLINE_EXHAUSTED')),remaining);
 let stop:()=>void=()=>{};
 try {
  controller.signal.throwIfAborted();
  return await buildTaskDeadlines.run({signal:controller.signal,deadlineAt:Math.min(row.deadlineAt,input.parentDeadlineAt),admissionId:input.admissionId},()=>Promise.race([
   Promise.resolve().then(()=>{controller.signal.throwIfAborted();return next();}),
   new Promise<never>((_,reject)=>{stop=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',stop,{once:true});}),
  ]));
 }catch(error){if(controller.signal.aborted && !parent?.signal.aborted)await input.onTimeout?.();throw error;}
 finally{clearTimeout(timer);controller.signal.removeEventListener('abort',stop);parent?.signal.removeEventListener('abort',abortParent);}
}
/** Reuse Flue's task execution boundary. Cancellation is propagated into real
 * model streams and sandbox commands; host effects reject the expired scope.
 * The race settles callers but is never the sole cancellation mechanism. */
export function makeTaskDeadlineInstrumentation(config:{resolve:()=>D1Database|null;onTimeout?:(db:D1Database,input:{runId:string;projectId:string;admissionId:string;taskKey:string})=>Promise<void>}):FlueInstrumentation {
 return {observe(){},dispose(){},async interceptor(operation,context,next) {
  currentBuildTask()?.signal.throwIfAborted();
  if(operation.type!=='task')return next();
  const db=config.resolve();if(!db)return next();
  const keys=[context.instanceId,context.conversationId].filter((value):value is string=>Boolean(value));if(!keys.length)return next();
  const workflow=(await db.prepare(`select * from build_workflows where conversationId in (${keys.map(()=>'?').join(',')}) limit 1`).bind(...keys).all<{runId:string;projectId:string;spendPayerId:string;phase:string}>()).results[0];
  if(!workflow||workflow.phase!=='building'||!workflow.spendPayerId)return next();
  const admitted=buildAttemptAdmittedAt(workflow.spendPayerId,null);if(admitted===null)return next();
  const taskKey=createHash('sha256').update(JSON.stringify([context.instanceId,context.submissionId,operation.taskId])).digest('hex');
  return withBuildTaskDeadline({db,runId:workflow.runId,admissionId:workflow.spendPayerId,taskKey,parentDeadlineAt:admitted+60*60_000,
   onTimeout:()=>config.onTimeout?.(db,{runId:workflow.runId,projectId:workflow.projectId,admissionId:workflow.spendPayerId,taskKey})??Promise.resolve()},next);
 }};
}
