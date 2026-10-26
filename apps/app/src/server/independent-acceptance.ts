import type {AcceptanceJourneys} from '@caddie/contracts';
import type {RuntimeCandidate} from './acceptance-candidate.ts';
import {createHash} from 'node:crypto';
import type {D1Database} from './auth.ts';
export interface AcceptanceIdentity {
 projectId:string;runId:string;admissionId:string;planId:string;designId:string;featureId:string;checkedImage:string;
}
export interface AcceptanceCriterion {featureId:string;text:string;}
export interface AcceptanceEvidence {criterionHash:string;passed:boolean;evidenceId:string;}
export interface IndependentAcceptanceResult {identity:AcceptanceIdentity;checks:AcceptanceEvidence[];}
/** Host binding only. This capability is never mounted as a model tool. Its
 * checks live outside the builder workspace and cover prior/current criteria. */
export interface IndependentAcceptancePort {
 check(input:{identity:AcceptanceIdentity;criteria:readonly AcceptanceCriterion[];operationKey:string;signal?:AbortSignal;runtime?:RuntimeCandidate;journeys?:AcceptanceJourneys}):Promise<IndependentAcceptanceResult>;
}
export const criterionHash=(criterion:AcceptanceCriterion)=>createHash('sha256').update(JSON.stringify([criterion.featureId,criterion.text])).digest('hex');
export function validateAcceptanceResult(identity:AcceptanceIdentity,criteria:readonly AcceptanceCriterion[],result:IndependentAcceptanceResult):boolean {
 const keys=Object.keys(identity) as Array<keyof AcceptanceIdentity>;
 if(!result?.identity || keys.some(key=>result.identity[key]!==identity[key]))throw new Error('Acceptance evidence belongs to another build');
 const required=new Set(criteria.map(criterionHash));
 if(required.size!==criteria.length || !Array.isArray(result.checks)||result.checks.length!==required.size||required.size===0)throw new Error('Complete independent criterion coverage is required');
 const seen=new Set<string>();
 for(const check of result.checks) {
  if(!required.has(check.criterionHash)||seen.has(check.criterionHash)||typeof check.passed!=='boolean'||typeof check.evidenceId!=='string'||check.evidenceId.length<8||check.evidenceId.length>512)
   throw new Error('Missing, duplicate or invalid independent evidence');
  seen.add(check.criterionHash);
 }
 return result.checks.every(check=>check.passed);
}
export async function runIndependentAcceptance(db:D1Database,input:{identity:AcceptanceIdentity;criteria:readonly AcceptanceCriterion[];operationKey:string;port?:IndependentAcceptancePort;signal?:AbortSignal;runtime?:RuntimeCandidate;journeys?:AcceptanceJourneys}) {
 const previous=(await db.prepare('select status,evidenceJson from feature_acceptance_receipts where operationKey=?').bind(input.operationKey).all<{status:'passed'|'failed'|'not-checked';evidenceJson:string}>()).results[0];
 if(previous) {
  const result=JSON.parse(previous.evidenceJson) as IndependentAcceptanceResult;
  if(JSON.stringify(result.identity)!==JSON.stringify(input.identity))throw new Error('Acceptance replay belongs to another build');
  if(previous.status!=='not-checked')validateAcceptanceResult(input.identity,input.criteria,result);
  return {status:previous.status};
 }
 const identityHash=createHash('sha256').update(JSON.stringify(input.identity)).digest('hex');
 if(input.port) {
  const claimed=await db.prepare("insert or ignore into feature_acceptance_claims(operationKey,identityHash,state,createdAt) values(?,?,'executing',?)").bind(input.operationKey,identityHash,new Date().toISOString()).run() as {meta?:{changes?:number}};
  if(claimed.meta?.changes!==1)throw new Error('Independent acceptance is already executing or requires its recorded result; do not execute it again');
 }
 let status:'passed'|'failed'|'not-checked'='not-checked';let evidence:unknown={identity:input.identity,reason:'Independent runtime checks are unavailable'};
 if(input.port) {
  try {
   const signal=AbortSignal.any([...(input.signal?[input.signal]:[]),AbortSignal.timeout(120_000)]);
   const result=await new Promise<IndependentAcceptanceResult>((resolve,reject)=>{const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)return abort();input.port!.check({...input,signal}).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});signal.throwIfAborted();
   status=validateAcceptanceResult(input.identity,input.criteria,result)?'passed':'failed';evidence=result;
  }catch {input.signal?.throwIfAborted();}
 }
 await db.prepare('insert or ignore into feature_acceptance_receipts(operationKey,projectId,runId,admissionId,planId,designId,featureId,checkedImage,status,evidenceJson,createdAt) values(?,?,?,?,?,?,?,?,?,?,?)')
  .bind(input.operationKey,input.identity.projectId,input.identity.runId,input.identity.admissionId,input.identity.planId,input.identity.designId,input.identity.featureId,input.identity.checkedImage,status,JSON.stringify(evidence),new Date().toISOString()).run();
 if(input.port)await db.prepare("update feature_acceptance_claims set state='settled' where operationKey=? and identityHash=?").bind(input.operationKey,identityHash).run();
 return {status};
}
export function serviceIndependentAcceptance(service:{fetch:(request:Request)=>Promise<Response>}):IndependentAcceptancePort {
 return {async check(input) {
  const response=await service.fetch(new Request('https://caddie-acceptance.internal/check',{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({identity:input.identity,criteria:input.criteria,operationKey:input.operationKey,runtime:input.runtime,journeys:input.journeys}),signal:input.signal}));
  if(!response.ok)throw new Error('Independent runtime checks did not complete');
  return await response.json() as IndependentAcceptanceResult;
 }};
}
