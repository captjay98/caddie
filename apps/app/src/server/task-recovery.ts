import type {D1Database} from './auth.ts';
import {recordCheckedRepair} from './repair-escalation.ts';
import {blockBuildByPayer} from './build-spend.ts';
import {buildAttemptAdmittedAt} from './build-deadlines.ts';
/** A timeout is a host-observed failed attempt. Reconcile uncertain writes by
 * their original keys before any new writer; safe retries keep the same payer. */
export async function recoverTimedOutTask(db:D1Database,input:{runId:string;projectId:string;admissionId:string;taskKey:string},reconcile?:(operationKey:string)=>Promise<{state:string}>) {
 const workflow=(await db.prepare('select phase,spendPayerId,repairPolicyVersion from build_workflows where runId=? and projectId=?').bind(input.runId,input.projectId).all<{phase:string;spendPayerId:string;repairPolicyVersion:string}>()).results[0];
 if(!workflow||workflow.phase!=='building'||workflow.spendPayerId!==input.admissionId)return {action:'stop'};
 const block=async(message:string)=>{await blockBuildByPayer(db,input.admissionId,message);return {action:'stop'};};
 const admitted=buildAttemptAdmittedAt(input.admissionId,null);
 if(admitted===null||Date.now()>=admitted+3600000)return block('This build reached its time allowance. Your plan and saved work are retained. The app is not ready yet.');
 const uncertain=(await db.prepare("select operationKey,status from external_operations where runId=? and status not in ('succeeded','failed','cancelled')").bind(input.runId).all<{operationKey:string;status:string}>()).results;
 if(uncertain.length)return block('Caddie is checking an interrupted operation before it can safely continue. Your plan and saved work are retained.');
 const records=(await db.prepare("select recordJson from sandbox_bindings where runId=? and kind='operation' order by updatedAt desc limit 32").bind(input.runId).all<{recordJson:string}>()).results;
 for(const row of records) {
  const record=JSON.parse(row.recordJson) as {state:string;operationKey:string};
  if(['dispatching','dispatched','ambiguous','cancel-requested'].includes(record.state)) {
   const result=await reconcile?.(record.operationKey).catch(()=>({state:'unknown'}));
   if(!result||!['succeeded','failed','cancelled'].includes(result.state))return block('Caddie could not confirm whether an interrupted operation finished. Your plan and saved work are retained; it will not start a second writer.');
  }
 }
 if(workflow.repairPolicyVersion!=='repair-v1')return block('Caddie could not finish this step within its time allowance. Your plan and saved work are retained.');
 const repair=await recordCheckedRepair(db,{runId:input.runId,admissionId:input.admissionId,operationKey:`deadline:${input.taskKey}`,issue:'specialist-deadline',detail:'Host specialist deadline expired; actual work was cancelled and pending effects reconciled.'});
 if(!repair||repair.paused)return block('Caddie used this build’s repair allowance without finishing the app. Your plan and saved work are retained.');
 return {action:'retry-current-feature',routeId:repair.routeId};
}
