import {HASH_ROUTES_RULE,type AcceptanceJourneys,type AcceptanceStep} from '@caddie/contracts';
import type {RuntimeCandidate} from './acceptance-candidate.ts';
import {createHash} from 'node:crypto';
import type {D1Database} from './auth.ts';
export interface AcceptanceIdentity {
 projectId:string;runId:string;admissionId:string;planId:string;designId:string;featureId:string;checkedImage:string;
}
export interface AcceptanceCriterion {featureId:string;text:string;}
/** `reason` is the checker's own failure text (never the builder's). Without
 * it a failed check reaches the repair blind: the 2026-10-30 EggOps run spent
 * $0.27 of Super VL re-reading the whole app because the host said only
 * "independent criteria failed" when the sign-in field was simply missing. */
export interface AcceptanceEvidence {criterionHash:string;passed:boolean;evidenceId:string;reason?:string;}
export interface IndependentAcceptanceResult {identity:AcceptanceIdentity;checks:AcceptanceEvidence[];}
export interface AcceptanceFailure {featureId:string;text:string;reason:string;}
export const ACCEPTANCE_REASON_MAX=600;
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
  if(!required.has(check.criterionHash)||seen.has(check.criterionHash)||typeof check.passed!=='boolean'||typeof check.evidenceId!=='string'||check.evidenceId.length<8||check.evidenceId.length>512
   ||(check.reason!==undefined&&typeof check.reason!=='string'))
   throw new Error('Missing, duplicate or invalid independent evidence');
  seen.add(check.criterionHash);
 }
 return result.checks.every(check=>check.passed);
}
/** The failed criteria of a validated result, with the checker's reason. */
export function acceptanceFailures(criteria:readonly AcceptanceCriterion[],result:IndependentAcceptanceResult|undefined):AcceptanceFailure[] {
 if(!result||!Array.isArray(result.checks))return [];
 const byHash=new Map(criteria.map(criterion=>[criterionHash(criterion),criterion]));
 return result.checks.flatMap(check=>{
  const criterion=check.passed?undefined:byHash.get(check.criterionHash);
  if(!criterion)return [];
  const reason=typeof check.reason==='string'?check.reason.replace(ANSI,'').replace(/\s+/g,' ').trim().slice(0,ACCEPTANCE_REASON_MAX):'';
  return [{featureId:criterion.featureId,text:criterion.text,reason}];
 });
}
/** One line per host action, in the words the builder needs to reproduce it. */
export function describeJourney(steps:readonly AcceptanceStep[]):string {
 return steps.map(step=>{
  switch(step.kind) {
   case 'open':return `open "#${step.path}"`;
   case 'fill':return `fill the field labelled "${step.label}" with "${step.value}"`;
   case 'click':return `press "${step.name}"`;
   case 'expect':return step.visible===false?`expect "${step.text}" not to show`:`expect "${step.text}" to show`;
   case 'actor':return `sign in as person ${step.user.toUpperCase()}`;
   case 'offline':return step.value?'go offline':'come back online';
   case 'reload':return 'reload the page';
   case 'restart':return 'restart the server and clear the browser cache';
   case 'fault':return step.mode==='clear'?`let ${step.path} answer again`:`make ${step.path} ${step.mode==='fail'?'fail':'hang'}`;
  }
 }).join(' → ');
}
const SIGN_IN_MISSING=/getByLabel\('(?:Email|Code)'|labelled "Email"|name: 'Email me a code'|name: 'Sign in'|sign-in code did not reach/;
export const SIGN_IN_JOURNEY_RULE='The host signs in the way a person does, where the journey has got to: it opens the screens and presses the buttons listed before "sign in as person A", then fills the field labelled "Email", presses "Email me a code", fills "Code" and presses "Sign in". Any screen that needs an account must show Caddie\'s <SignIn /> from caddie/sign-in.tsx (labels unchanged) right there while nobody is signed in — not a redirect, not a custom form.';
/** Each criterion runs in its own fresh database (acceptance-runtime scopes by
 * session), so nothing a previous check saved is there. */
export const EMPTY_START_RULE='Each check starts on an empty app: a new person who has saved nothing yet, and only the listed steps happen, so every screen a check opens must work for that person.';
// Playwright colours its messages; the escape codes are noise to a builder.
const ANSI=/\u001b\[[0-9;]*m/g;
/** What the coordinator hands the repair: each failed check, what the host did,
 * and where it broke. Bounded so a long Playwright log cannot flood the turn. */
export function acceptanceRepairBrief(failures:readonly AcceptanceFailure[],journeys:AcceptanceJourneys|undefined):string {
 if(!failures.length)return 'The host\'s independent checks failed without a recorded reason. Run run_checks, then compare each screen with the caddie-checks steps in the approved design.';
 const lines=failures.slice(0,6).map((failure,index)=>{
  const steps=journeys?.criteria.find(item=>item.featureId===failure.featureId&&item.text===failure.text)?.steps;
  const reason=failure.reason.split(/ Call log:/)[0]!.trim()||'no reason recorded';
  const waited=/waiting for (.{1,160}?)(?:$| - )/.exec(failure.reason)?.[1];
  // A check that types nothing reaches its screens on an empty app: the
  // brand-new person sees only what the app shows with no saved records
  // (2026-10-30 EggOps: "See all days → expect 205" with no flock or counts).
  const empty=steps&&steps.some(step=>step.kind==='actor')&&!steps.some(step=>step.kind==='fill')
   ?' Nothing is typed or saved in this check, so the brand-new person has no records there: the expected text must appear for an account with no saved data (for example sample data the approved plan already promises, marked as such), or the check cannot pass as written.':'';
  return `${index+1}. “${failure.text}”${steps?` — the host did: ${describeJourney(steps)}`:''}. It broke at: ${reason}${waited?` (waiting for ${waited.trim()})`:''}.${empty}`;
 });
 const signIn=failures.some(failure=>SIGN_IN_MISSING.test(failure.reason))?` ${SIGN_IN_JOURNEY_RULE}`:'';
 // Every journey reaches its screens through the hash, so a router that reads
 // the address path never leaves the first screen; say so whenever one opens.
 const opens=failures.some(failure=>journeys?.criteria.find(item=>item.featureId===failure.featureId&&item.text===failure.text)?.steps.some(step=>step.kind==='open'));
 // Rules first: the brief is cut at 3000 chars and the resume capsule keeps
 // only its head, so the reusable rules must never be what gets cut.
 const rules=`${EMPTY_START_RULE}${opens?` ${HASH_ROUTES_RULE}`:''}${signIn}`;
 return `The host's independent checks failed (${failures.length}). ${rules}\n${lines.join('\n')}`.slice(0,3000);
}
export async function runIndependentAcceptance(db:D1Database,input:{identity:AcceptanceIdentity;criteria:readonly AcceptanceCriterion[];operationKey:string;port?:IndependentAcceptancePort;signal?:AbortSignal;runtime?:RuntimeCandidate;journeys?:AcceptanceJourneys}) {
 const previous=(await db.prepare('select status,evidenceJson from feature_acceptance_receipts where operationKey=?').bind(input.operationKey).all<{status:'passed'|'failed'|'not-checked';evidenceJson:string}>()).results[0];
 if(previous) {
  const result=JSON.parse(previous.evidenceJson) as IndependentAcceptanceResult;
  if(JSON.stringify(result.identity)!==JSON.stringify(input.identity))throw new Error('Acceptance replay belongs to another build');
  if(previous.status!=='not-checked')validateAcceptanceResult(input.identity,input.criteria,result);
  return {status:previous.status,failures:previous.status==='failed'?acceptanceFailures(input.criteria,result):[]};
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
 return {status,failures:status==='failed'?acceptanceFailures(input.criteria,evidence as IndependentAcceptanceResult):[]};
}
export function serviceIndependentAcceptance(service:{fetch:(request:Request)=>Promise<Response>}):IndependentAcceptancePort {
 return {async check(input) {
  const response=await service.fetch(new Request('https://caddie-acceptance.internal/check',{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({identity:input.identity,criteria:input.criteria,operationKey:input.operationKey,runtime:input.runtime,journeys:input.journeys}),signal:input.signal}));
  if(!response.ok)throw new Error('Independent runtime checks did not complete');
  return await response.json() as IndependentAcceptanceResult;
 }};
}
