import { BuildRecoveryError } from './build-recovery.ts';
import { createHash } from 'node:crypto';
import { ARTIFACT_QUALITY_POLICY, parseArtifactQualityReview, type ArtifactQualityReview, type QualityStage, type ReviewImage } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { createBuildPayer } from './build-spend.ts';
import { ScopeError } from './scope.ts';
import { findModelRoute, routeAcceptsImage } from '../agents/providers.ts';
import { validateReviewImages, type DesignReviewCapturePort, type ReviewState } from './design-review-capture.ts';
export const QUALITY_LIMIT_MICROS=1_000_000;
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
export interface QualityReviewer {
 review(input:{routeId:string;body:string;context:string;stage?:QualityStage;images:readonly ReviewImage[];payerId:string;operationKey:string;deadlineAt:number;signal?:AbortSignal}):Promise<ArtifactQualityReview>;
}
export async function admitQualityProject(db:D1Database,projectId:string,env:unknown) {
 if((env as {CADDIE_QUALITY_POLICY?:string}|undefined)?.CADDIE_QUALITY_POLICY!==ARTIFACT_QUALITY_POLICY) return;
 await db.prepare('insert or ignore into quality_projects(projectId,policyVersion,authorRouteId,createdAt) values(?,?,?,?)')
  .bind(projectId,ARTIFACT_QUALITY_POLICY,'glm-5.3-flash',new Date().toISOString()).run();
}
export async function qualityEnabled(db:D1Database,projectId:string):Promise<boolean> {
 try {return (await db.prepare('select 1 from quality_projects where projectId=? and policyVersion=?').bind(projectId,ARTIFACT_QUALITY_POLICY).all()).results.length>0;}
 catch(error){if(String(error).includes('no such table: quality_projects'))return false;throw error;}
}
export async function qualityAdmission(db:D1Database,projectId:string,kind:QualityStage) {
 if(!await qualityEnabled(db,projectId))return null;
 const workflow=(await db.prepare('select * from build_workflows where projectId=?').bind(projectId).all<Record<string,unknown>>()).results[0];
 const phase=kind==='prd'?'planning':kind;
 if(!workflow || workflow.phase!==phase)throw new ScopeError(409,'QUALITY_WRONG_PHASE','The artifact does not belong to the current preparation step.');
 const decision=(await db.prepare('select id from plan_decisions where projectId=? order by rowid desc limit 1').bind(projectId).all<{id:string}>()).results[0]?.id??null;
 const dependencyHash=hash(JSON.stringify([workflow.brief,workflow.planId,phase,decision]));
 const id=`prep_${hash(JSON.stringify([projectId,kind,dependencyHash]))}`;
 const payerId=`preparation:${id}`;const stamp=new Date().toISOString();
 await createBuildPayer(db,payerId,QUALITY_LIMIT_MICROS);
 await db.prepare('insert or ignore into quality_admissions(id,projectId,stage,dependencyHash,payerId,expiresAt,createdAt,phase,planId,brief,decisionId) values(?,?,?,?,?,?,?,?,?,?,?)')
  .bind(id,projectId,kind,dependencyHash,payerId,new Date(Date.now()+15*60_000).toISOString(),stamp,phase,workflow.planId,workflow.brief,decision).run();
 const stored=(await db.prepare('select * from quality_admissions where id=?').bind(id).all<{id:string;payerId:string;expiresAt:string;brief:string;planId:string|null;decisionId:string|null}>()).results[0]!;
 if(Date.now()>=Date.parse(stored.expiresAt))throw new ScopeError(409,'QUALITY_TIME_LIMIT','Caddie could not complete this review within its allowance. Earlier approved work is retained.');
 const used=(await db.prepare('select count(*) n from build_spend_reservations where payerId=?').bind(stored.payerId).all<{n:number}>()).results[0]?.n??0;
 if(used>=48)throw new ScopeError(409,'QUALITY_CALL_LIMIT','Caddie could not finish this preparation within its allowance. Earlier approved work is retained.');
 return stored;
}
/** Called only by an authoring effect, never by a polling/read route. The
 * candidate lives outside published revisions until the SQL publication gate
 * accepts the exact hash and unchanged dependencies. Reviewers have no tools.
 */
export async function reviewArtifactCandidate(db:D1Database,input:{projectId:string;kind:QualityStage;body:string;authorRouteId:string;
 reviewer:QualityReviewer;states?:readonly ReviewState[];capture?:DesignReviewCapturePort;signal?:AbortSignal}) {
 const admission=await qualityAdmission(db,input.projectId,input.kind);if(!admission)return null;
 const reviewSignal=AbortSignal.any([...(input.signal?[input.signal]:[]),AbortSignal.timeout(Math.max(1,Date.parse(admission.expiresAt)-Date.now()))]);
 const bounded=<T>(work:(signal:AbortSignal)=>Promise<T>,milliseconds:number)=>{const signal=AbortSignal.any([reviewSignal,AbortSignal.timeout(milliseconds)]);return new Promise<T>((resolve,reject)=>{const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)return abort();work(signal).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});};
 const bodyHash=hash(input.body);const id=`candidate_${hash(JSON.stringify([admission.id,bodyHash]))}`;
 const existing=(await db.prepare('select id,status from artifact_candidates where id=?').bind(id).all<{id:string;status:string}>()).results[0];
 if(existing) {
  if(existing.status==='passed'||existing.status==='published')return {id,bodyHash};
  const review=(await db.prepare('select findingsJson from artifact_quality_reviews where candidateId=?').bind(id).all<{findingsJson:string}>()).results[0];
  throw new ScopeError(409,'QUALITY_REVISION_REQUIRED',review?.findingsJson??'This review is still pending. Do not replay its inference or present it as ready.');
 }
 // Allocation and the cap are checked in one insert. Concurrent authors cannot
 // both consume the same round or create an unbounded correction sequence.
 await db.prepare(`insert into artifact_candidates(id,admissionId,projectId,kind,bodyHash,body,authorRouteId,round,status,createdAt)
  select ?,?,?,?,?,?,?,coalesce(max(round),0)+1,'pending',? from artifact_candidates where admissionId=? having coalesce(max(round),0)<3`)
  .bind(id,admission.id,input.projectId,input.kind,bodyHash,input.body,input.authorRouteId,new Date().toISOString(),admission.id).run();
 const candidate=(await db.prepare('select id from artifact_candidates where id=?').bind(id).all()).results[0];
 if(!candidate)throw new ScopeError(409,'QUALITY_REPAIR_LIMIT','Caddie could not prepare a checked revision within its allowance. Earlier approved work is retained.');
 let images:ReviewImage[]=[];
 let reviewerRoute='';
 try {
  input.signal?.throwIfAborted();
  if(input.kind!=='prd') {
   if(!input.capture || !input.states)throw new Error('Actual phone and desktop preview capture is unavailable');
   images=await bounded(signal=>input.capture!.capture(input.states!,signal),120_000);validateReviewImages(input.states,images);
  }
  const plan=admission.planId?(await db.prepare('select body from plan_doc_revisions where projectId=? and id=?').bind(input.projectId,admission.planId).all<{body:string}>()).results[0]?.body:null;
  const chosenLook=(await db.prepare("select p.body,d.note from plan_decisions d join plan_doc_revisions p on p.id=d.planRevisionId where d.projectId=? and p.kind='looks' and d.decision='approved' order by d.rowid desc limit 1").bind(input.projectId).all()).results[0]??null;
  const context=JSON.stringify({userIntent:admission.brief,approvedPlan:plan??null,chosenLook});
  const routes=input.kind==='prd'?['deepseek-v4.1-flash-1017','glm-5.3']:['deepseek-v4.1-flash-1017','nemotron-3.5-super-vl'];
  const eligible=routes.filter(route=>route!==input.authorRouteId && (input.kind==='prd'||routeAcceptsImage(route)));
  let review:ArtifactQualityReview|undefined;
  await db.prepare("update artifact_candidates set status='reviewing' where id=? and status='pending'").bind(id).run();
  for(const routeId of eligible) {
   findModelRoute(routeId);reviewerRoute=routeId;
   try {
    review=parseArtifactQualityReview(await bounded(signal=>input.reviewer.review({routeId,body:input.body,stage:input.kind,context,
     images,payerId:admission.payerId,operationKey:`quality:${id}:${routeId}`,deadlineAt:Date.parse(admission.expiresAt),signal}),300_000));break;
   } catch(error) {input.signal?.throwIfAborted();if(error instanceof BuildRecoveryError && error.decision.kind!=='transient-service')throw error;}
  }
  if(!review)throw new Error('No independent reviewer completed');
  await db.batch([
   db.prepare('insert into artifact_quality_reviews(candidateId,policyVersion,reviewerRouteId,verdict,findingsJson,captureManifestJson,createdAt) values(?,?,?,?,?,?,?)')
    .bind(id,ARTIFACT_QUALITY_POLICY,reviewerRoute,review.verdict,JSON.stringify(review.findings),JSON.stringify(images.map(({pngBase64:_,...manifest})=>manifest)),new Date().toISOString()),
   db.prepare('update artifact_candidates set status=? where id=?').bind(review.verdict==='pass'?'passed':'revise',id),
  ]);
  if(review.verdict!=='pass')throw new ScopeError(409,'QUALITY_REVISION_REQUIRED',`Fix these findings internally before presenting the revision: ${JSON.stringify(review.findings)}`);
  return {id,bodyHash};
 } catch(error) {
  input.signal?.throwIfAborted();
  if(error instanceof ScopeError)throw error;
  await db.prepare("update artifact_candidates set status='blocked' where id=? and status in ('pending','reviewing')").bind(id).run();
  throw new ScopeError(409,'QUALITY_UNAVAILABLE','The independent review could not finish. Earlier approved work is retained; this draft is not ready to present.');
 }
}
