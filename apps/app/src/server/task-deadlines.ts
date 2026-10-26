import {parseArchitectureBlock} from '@caddie/contracts';
import {moduleFeatureMap} from './big-build.ts';
import {findModelRoute} from '../agents/providers.ts';
import {REPAIR_ROUTES,repairState} from './repair-escalation.ts';
import {createHash} from 'node:crypto';
import type {FlueInstrumentation} from '@flue/runtime';
import type {D1Database} from './auth.ts';
import {buildTaskDeadlines,currentBuildTask} from './task-deadline-context.ts';
import {buildAttemptAdmittedAt,DEADLINE_POLICY} from './build-deadlines.ts';
export async function withBuildTaskDeadline<T>(input:{db:D1Database;runId:string;admissionId:string;taskKey:string;parentDeadlineAt:number;allowanceMs?:number;repairRouteId?:string|null;featureIds?:readonly string[];moduleInstance?:string;onTimeout?:()=>Promise<void>},next:()=>Promise<T>):Promise<T> {
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
  return await buildTaskDeadlines.run({signal:controller.signal,deadlineAt:Math.min(row.deadlineAt,input.parentDeadlineAt),admissionId:input.admissionId,runId:input.runId,repairRouteId:input.repairRouteId,featureIds:input.featureIds,moduleInstance:input.moduleInstance},()=>Promise.race([
   Promise.resolve().then(()=>{controller.signal.throwIfAborted();return next();}),
   new Promise<never>((_,reject)=>{stop=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',stop,{once:true});}),
  ]));
 }catch(error){if(controller.signal.aborted && !parent?.signal.aborted)await input.onTimeout?.();throw error;}
 finally{clearTimeout(timer);controller.signal.removeEventListener('abort',stop);parent?.signal.removeEventListener('abort',abortParent);}
}
/** Reuse Flue's task execution boundary. Cancellation is propagated into real
 * model streams and sandbox commands; host effects reject the expired scope.
 * The race settles callers but is never the sole cancellation mechanism. */
export function makeTaskDeadlineInstrumentation(config:{resolve:()=>D1Database|null;onTimeout?:(db:D1Database,input:{runId:string;projectId:string;admissionId:string;taskKey:string;featureIds?:readonly string[];sessionId?:string})=>Promise<void>}):FlueInstrumentation {
 const requested=new Map<string,string>();
 return {observe(event){if(event.type==='turn_request'){if(requested.size>=256)requested.delete(requested.keys().next().value!);requested.set(event.turnId,event.request.requestedModel);}if(event.type==='turn')requested.delete(event.turnId);},dispose(){requested.clear();},async interceptor(operation,context,next) {
  currentBuildTask()?.signal.throwIfAborted();
  const db=config.resolve();if(!db)return next();
  const task=currentBuildTask();
  if(operation.type==='model'&&task?.runId&&task.repairRouteId!==undefined) {
    const active=(await db.prepare('select phase,spendPayerId from build_workflows where runId=?').bind(task.runId).all<{phase:string;spendPayerId:string}>()).results[0];
    if(!active||active.phase!=='building'||active.spendPayerId!==task.admissionId)throw new Error('BUILD_STOPPED: this delegate no longer owns the admitted build.');
    if(task.moduleInstance){const module=(await db.prepare("select status,payerId from build_modules where ?=(projectId||':'||buildSeq||':'||moduleId)").bind(task.moduleInstance).all<{status:string;payerId:string}>()).results[0];if(module?.status!=='building'||module.payerId!==task.admissionId)throw new Error('BUILD_STOPPED: this module is no longer active.');}
    const state=await repairState(db,task.runId,task.featureIds);
    const selected=REPAIR_ROUTES.find(id=>findModelRoute(id).modelId===requested.get(operation.turnId));
    if(state&&(state.routeId!==task.repairRouteId||(selected&&selected!==state.routeId)))throw new Error('REPAIR_ROUTE_CHANGED: end this delegate; call build_next_feature and delegate the current feature with the refreshed host-selected model. This is an internal hand-off, not a user blocker.');
  }
  if(operation.type!=='task')return next();
  const keys=[context.instanceId,context.conversationId].filter((value):value is string=>Boolean(value));if(!keys.length)return next();
  let workflow=(await db.prepare(`select * from build_workflows where conversationId in (${keys.map(()=>'?').join(',')}) limit 1`).bind(...keys).all<{runId:string;projectId:string;spendPayerId:string;phase:string}>()).results[0];
  let featureIds:readonly string[]|undefined;let moduleInstance:string|undefined;
  if(!workflow) {
    // ModuleBuilder instances share the build payer but have their own durable
    // identity and feature episode. Never borrow another module's counter.
    let module:({runId:string;projectId:string;spendPayerId:string;phase:string;moduleId:string;approvedDesignRevisionId:string;planId:string})|undefined;
    try{module=(await db.prepare(`select w.*,m.moduleId from build_modules m join build_workflows w on w.projectId=m.projectId and w.spendPayerId=m.payerId where m.status='building' and (m.projectId||':'||m.buildSeq||':'||m.moduleId) in (${keys.map(()=>'?').join(',')}) limit 1`).bind(...keys).all<NonNullable<typeof module>>()).results[0];}catch(error){if(!String(error).includes('no such table'))throw error;}
    if(module){workflow=module;moduleInstance=keys.find(key=>key.startsWith(`${module!.projectId}:`));
      const design=(await db.prepare('select body from plan_doc_revisions where id=? and projectId=?').bind(module.approvedDesignRevisionId,module.projectId).all<{body:string}>()).results[0];
      const architecture=parseArchitectureBlock(design?.body??'');if(!architecture.ok)throw new Error('The module has no approved architecture.');
      const rows=(await db.prepare('select featureId from build_features where runId=? and planId=? order by position').bind(module.runId,module.planId).all<{featureId:string}>()).results;
      featureIds=moduleFeatureMap(architecture.block,rows.map(row=>row.featureId)).get(module.moduleId)??[];
    }
  }
  if(!workflow||workflow.phase!=='building'||!workflow.spendPayerId)return next();
  const admitted=buildAttemptAdmittedAt(workflow.spendPayerId,null);if(admitted===null)return next();
  const repair=await repairState(db,workflow.runId,featureIds);
  const taskKey=createHash('sha256').update(JSON.stringify([context.instanceId,context.submissionId,operation.taskId])).digest('hex');
  return withBuildTaskDeadline({db,runId:workflow.runId,admissionId:workflow.spendPayerId,taskKey,parentDeadlineAt:admitted+60*60_000,featureIds,moduleInstance,...(repair?{repairRouteId:repair.routeId}:{}),
   onTimeout:()=>config.onTimeout?.(db,{runId:workflow.runId,projectId:workflow.projectId,admissionId:workflow.spendPayerId,taskKey,featureIds,...(moduleInstance?{sessionId:`module:${workflow.runId}:${moduleInstance.split(':').at(-1)}`}:{sessionId:`session:${workflow.runId}`})})??Promise.resolve()},next);
 }};
}
