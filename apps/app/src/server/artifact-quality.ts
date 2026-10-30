import { BuildRecoveryError } from './build-recovery.ts';
import { createHash } from 'node:crypto';
import { ARTIFACT_QUALITY_POLICY, parseArtifactQualityReview, type ArtifactQualityReview, type QualityStage, type ReviewImage } from '@caddie/contracts';
import type { D1Database } from './auth.ts';
import { createBuildPayer } from './build-spend.ts';
import { ScopeError } from './scope.ts';
import { findModelRoute, routeAcceptsImage } from '../agents/providers.ts';
import { validateReviewImages, type DesignReviewCapturePort, type ReviewState } from './design-review-capture.ts';
// Per-window preparation allowance. Design/looks reviews capture and score real
// phone+desktop screenshots per round — measurably more calls than a text PRD
// review — so the design stages get a larger bounded window (owner 2026-10-28:
// the $1 text cap kept expiring mid-visual-review; each window remains a hard
// cap, never a target).
export const QUALITY_LIMIT_MICROS=1_000_000;
export const QUALITY_VISUAL_LIMIT_MICROS=2_500_000;
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
export interface QualityReviewer {
 review(input:{routeId:string;body:string;context:string;stage?:QualityStage;images:readonly ReviewImage[];payerId:string;operationKey:string;deadlineAt:number;signal?:AbortSignal}):Promise<ArtifactQualityReview>;
}
export async function admitQualityProject(db:D1Database,projectId:string,_env?:unknown) {
 try { await db.prepare("select 1 from quality_projects limit 1").all(); } catch(error) { if(String(error).includes('no such table')) return; throw error; }
 // Owner 2026-10-27: the independent quality gate is DEFAULT-ON for every
 // project — the same default-and-only rule the repair ladder already follows.
 // It was env-gated behind CADDIE_QUALITY_POLICY, which left real runs
 // unreviewed unless an operator remembered to opt in; that is exactly the
 // failure mode the repair-ladder change removed. The `env` parameter stays
 // for call-site compatibility and is ignored.
 await db.prepare('insert or ignore into quality_projects(projectId,policyVersion,authorRouteId,createdAt) values(?,?,?,?)')
  .bind(projectId,ARTIFACT_QUALITY_POLICY,findModelRoute('deepseek-v4.1-flash-1017').id,new Date().toISOString()).run();
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
 // An expired admission must grant a FRESH window, not deadlock the phase:
 // the base id derives from the dependency state (brief/planId/phase/decision),
 // so a failed authoring turn used to regenerate the same expired row forever
 // and every later save threw QUALITY_TIME_LIMIT (Farmhand planning deadlock,
 // 2026-10-28). Windows: the base id gets -w2, -w3… for each fresh window.
 // History stays intact — candidates keep their admissionId foreign keys; each
 // authoring pass still gets a bounded review window and payer.
 const baseId=`prep_${hash(JSON.stringify([projectId,kind,dependencyHash]))}`;
 let id=baseId;let window=1;
 // Windows opened for this step in the last half hour. A window whose three
 // reviewed rounds are used up rolls straight into the next one instead of
 // refusing every save until its 15 minutes run out (Poultry Tracker plan,
 // 2026-10-29: 9 idle minutes, ten refused saves). At most two windows per
 // half hour, so spend stays bounded.
 // Prefix match by substr, never LIKE: D1 refuses LIKE patterns over 50
 // bytes ("LIKE or GLOB pattern too complex"), and these ids are 69 (the
 // design step failed on it at once, 2026-10-29).
 const recentWindows=(await db.prepare("select count(*) n from quality_admissions where substr(id,1,?)=? and createdAt>?").bind(baseId.length,baseId,new Date(Date.now()-30*60_000).toISOString()).all<{n:number}>()).results[0]?.n??0;
 for(;;){
  const row=(await db.prepare('select expiresAt from quality_admissions where id=?').bind(id).all<{expiresAt:string}>()).results[0];
  if(!row)break;
  const reviewed=(await db.prepare("select count(*) n from artifact_candidates where admissionId=? and status in ('revise','passed','published')").bind(id).all<{n:number}>()).results[0]?.n??0;
  if(reviewed>=3 && Date.now()<Date.parse(row.expiresAt)) {
   const nextId=`${baseId}-w${window+1}`;
   const next=(await db.prepare('select 1 from quality_admissions where id=?').bind(nextId).all()).results.length>0;
   if(!next && recentWindows>=2)break;
   window+=1;id=nextId;continue;
  }
  // A window whose three rounds were ALL 'blocked' never had a review run
  // (the screenshot checker was down, a provider dropped): it judged nothing,
  // so it must not spend the owner's tries. Three such rounds used to fail
  // every retry at once on the round cap (Poultry Farm Monitor looks,
  // 2026-10-29). A window with any reviewed round keeps its cap.
  const unreviewed=(await db.prepare("select count(*) n, sum(case when status='blocked' then 1 else 0 end) b from artifact_candidates where admissionId=?").bind(id).all<{n:number;b:number|null}>()).results[0];
  const spentOnOutage=(unreviewed?.n??0)>=3 && unreviewed?.b===unreviewed?.n;
  if(Date.now()<Date.parse(row.expiresAt) && !spentOnOutage)break;
  window+=1;id=`${baseId}-w${window}`;
 }
 const payerId=`preparation:${id}`;const stamp=new Date().toISOString();
 await createBuildPayer(db,payerId,kind==='prd'?QUALITY_LIMIT_MICROS:QUALITY_VISUAL_LIMIT_MICROS);
 await db.prepare('insert or ignore into quality_admissions(id,projectId,stage,dependencyHash,payerId,expiresAt,createdAt,phase,planId,brief,decisionId) values(?,?,?,?,?,?,?,?,?,?,?)')
  .bind(id,projectId,kind,`${dependencyHash}:w${window}`,payerId,new Date(Date.now()+15*60_000).toISOString(),stamp,phase,workflow.planId,workflow.brief,decision).run();
 const stored=(await db.prepare('select * from quality_admissions where id=?').bind(id).all<{id:string;payerId:string;expiresAt:string;brief:string;planId:string|null;decisionId:string|null}>()).results[0]!;
 if(Date.now()>=Date.parse(stored.expiresAt))throw new ScopeError(409,'QUALITY_TIME_LIMIT','Caddie could not complete this review within its allowance. Earlier approved work is retained.');
 const used=(await db.prepare('select count(*) n from build_spend_reservations where payerId=?').bind(stored.payerId).all<{n:number}>()).results[0]?.n??0;
 if(used>=48)throw new ScopeError(409,'QUALITY_CALL_LIMIT','Caddie could not finish this preparation within its allowance. Earlier approved work is retained.');
 return stored;
}
/** The reviewer id machine checks are recorded under (no model, no spend). */
export const MACHINE_REVIEWER_ROUTE='machine-checks-v1';
export type MachineFinding={severity:'blocking'|'advisory';criterion:string;detail:string};
/**
 * Machine checks instead of an AI reviewer (owner 2026-10-29: "checking that
 * the theme is valid, that every feature has a screen, and that contrast and
 * tap sizes are right can all be measured in code … in seconds"). Records the
 * same candidate + review rows the publication trigger requires, so the SQL
 * gate is unchanged: only a draft whose measured findings carry no blocking
 * row is published. `check` runs the measurements (render + DOM audit).
 * Measured findings turn advisory on the window's last round, so a measured
 * nit can never deadlock a step; the owner still chooses the look.
 */
export async function recordMachineReview(db:D1Database,input:{projectId:string;kind:QualityStage;body:string;authorRouteId:string;
 check:(signal?:AbortSignal)=>Promise<MachineFinding[]>;signal?:AbortSignal}) {
 const admission=await qualityAdmission(db,input.projectId,input.kind);if(!admission)return null;
 const bodyHash=hash(input.body);const id=`candidate_${hash(JSON.stringify([admission.id,bodyHash]))}`;
 const existing=(await db.prepare('select status from artifact_candidates where id=?').bind(id).all<{status:string}>()).results[0];
 if(existing&&(existing.status==='passed'||existing.status==='published'))return {id,bodyHash,findings:[] as MachineFinding[]};
 if(existing){
  const review=(await db.prepare('select findingsJson from artifact_quality_reviews where candidateId=?').bind(id).all<{findingsJson:string}>()).results[0];
  throw new ScopeError(409,'QUALITY_REVISION_REQUIRED',`Fix these measured problems, then save again: ${review?.findingsJson??'[]'}`);
 }
 await db.prepare(`insert into artifact_candidates(id,admissionId,projectId,kind,bodyHash,body,authorRouteId,round,status,createdAt)
  select ?,?,?,?,?,?,?,coalesce(max(round),0)+1,'reviewing',? from artifact_candidates where admissionId=? having coalesce(max(round),0)<3`)
  .bind(id,admission.id,input.projectId,input.kind,bodyHash,input.body,input.authorRouteId,new Date().toISOString(),admission.id).run();
 const round=(await db.prepare('select round from artifact_candidates where id=?').bind(id).all<{round:number}>()).results[0]?.round;
 if(!round)throw new ScopeError(409,'QUALITY_REPAIR_LIMIT','Caddie could not prepare a checked revision within its allowance. Earlier approved work is retained.');
 let findings:MachineFinding[];
 try{findings=await input.check(input.signal);}
 catch(error){
  await db.prepare("update artifact_candidates set status='blocked' where id=? and status='reviewing'").bind(id).run();
  input.signal?.throwIfAborted();
  throw new ScopeError(409,'QUALITY_UNAVAILABLE',`The screen checks could not run (${error instanceof Error?error.message:'unknown error'}). Save again.`);
 }
 if(round>=3)findings=findings.map(row=>({...row,severity:'advisory' as const}));
 const verdict=findings.some(row=>row.severity==='blocking')?'revise':'pass';
 await db.batch([
  db.prepare('insert into artifact_quality_reviews(candidateId,policyVersion,reviewerRouteId,verdict,findingsJson,captureManifestJson,createdAt) values(?,?,?,?,?,?,?)')
   .bind(id,ARTIFACT_QUALITY_POLICY,MACHINE_REVIEWER_ROUTE,verdict,JSON.stringify(findings),'[]',new Date().toISOString()),
  db.prepare('update artifact_candidates set status=? where id=?').bind(verdict==='pass'?'passed':'revise',id),
 ]);
 if(verdict!=='pass')throw new ScopeError(409,'QUALITY_REVISION_REQUIRED',`Fix these measured problems, then save again: ${JSON.stringify(findings.filter(row=>row.severity==='blocking'))}`);
 return {id,bodyHash,findings};
}
/** Called only by an authoring effect, never by a polling/read route. The
 * candidate lives outside published revisions until the SQL publication gate
 * accepts the exact hash and unchanged dependencies. Reviewers have no tools.
 */
export async function reviewArtifactCandidate(db:D1Database,input:{projectId:string;kind:QualityStage;body:string;authorRouteId:string;
 reviewer:QualityReviewer;states?:readonly ReviewState[];capture?:DesignReviewCapturePort;signal?:AbortSignal}) {
 const admission=await qualityAdmission(db,input.projectId,input.kind);if(!admission)return null;
 const reviewSignal=AbortSignal.any([...(input.signal?[input.signal]:[]),AbortSignal.timeout(Math.max(1,Date.parse(admission.expiresAt)-Date.now()))]);
 // Visual reviews (design/looks) score captured phone+desktop screenshots per
// round — measurably slower than a text PRD pass. 300s killed legitimate
// Super VL/deepseek capture reviews mid-flight (2026-10-28 Farmhand: every
// design round timed out before the verdict landed).
const REVIEW_STAGE_TIMEOUT_MS = input.kind==='prd' ? 300_000 : 600_000;
const bounded=<T>(work:(signal:AbortSignal)=>Promise<T>,milliseconds:number)=>{const signal=AbortSignal.any([reviewSignal,AbortSignal.timeout(milliseconds)]);return new Promise<T>((resolve,reject)=>{const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)return abort();work(signal).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});};
 const bodyHash=hash(input.body);const id=`candidate_${hash(JSON.stringify([admission.id,bodyHash]))}`;
 // The exact draft was already sent back in an earlier window of this same
 // step: return those findings instead of paying for the same review again.
 const earlier=(await db.prepare("select r.findingsJson from artifact_candidates c join artifact_quality_reviews r on r.candidateId=c.id join quality_admissions a on a.id=c.admissionId where c.projectId=? and c.kind=? and c.bodyHash=? and c.status='revise' and c.admissionId<>? and substr(a.dependencyHash,1,64)=? order by r.createdAt desc limit 1")
  .bind(input.projectId,input.kind,bodyHash,admission.id,String((admission as {dependencyHash?:string}).dependencyHash??'').slice(0,64)).all<{findingsJson:string}>()).results[0];
 if(earlier)throw new ScopeError(409,'QUALITY_REVISION_REQUIRED',`Fix these findings internally before presenting the revision: ${earlier.findingsJson}`);
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
  // The revision the workflow points at is not necessarily an approved one:
  // during a replan it is the draft being replaced. Presenting it as
  // "approvedPlan" let a reviewer treat an unapproved draft as a binding
  // approval and refuse the owner's own authorized scope change — which the
  // reviewer cannot see anywhere, because it is told candidate text is not
  // evidence (Street Food Share, 2026-10-28). The approval state and the
  // owner's recorded change requests are host data, so they are evidence.
  const planApproval=admission.planId?(await db.prepare("select status from approvals where projectId=? and resourceId=? and action='design' order by rowid desc limit 1").bind(input.projectId,admission.planId).all<{status:string}>()).results[0]?.status??null:null;
  const ownerRequests=(await db.prepare("select d.note,p.kind from plan_decisions d left join plan_doc_revisions p on p.id=d.planRevisionId where d.projectId=? and d.decision='changes' and d.note is not null order by d.rowid desc limit 5").bind(input.projectId).all<{note:string|null;kind:string|null}>()).results;
  // The reviewer's own last findings on this step, so a revision is judged
  // against them first instead of against a fresh list each round (six
  // plan rounds, each raising a new blocker, 2026-10-29).
  const earlierFindings=(await db.prepare("select r.findingsJson from artifact_quality_reviews r join artifact_candidates c on c.id=r.candidateId where c.projectId=? and c.kind=? and c.id<>? order by r.createdAt desc limit 1").bind(input.projectId,input.kind,id).all<{findingsJson:string}>()).results[0]?.findingsJson;
  const context=JSON.stringify({userIntent:admission.brief,planInForce:plan??null,planApproval:planApproval??'not approved',chosenLook,ownerRequests,
   ...(earlierFindings?{yourEarlierFindings:JSON.parse(earlierFindings) as unknown}:{})});
  // Owner routing decision 2026-10-27: the PRD's independent reviewer is full
  // GLM-5.3 first (text-only — a PRD is text), with deepseek as the
  // different-family fallback and nemotron as the last resort; the author's
  // own route is filtered out below, so an author can never self-review. The
  // design ladder reviews actual captured phone+desktop screenshots, so every
  // route there must take images (glm-5.3 must never receive screenshots).
  const routes=input.kind==='prd'
    ?['glm-5.3','deepseek-v4.1-flash-1017','nemotron-3.5-super-vl']
    :['deepseek-v4.1-flash-1017','nemotron-3.5-super-vl'];
  // Independence is per FAMILY, not per route id (2026-10-27 decision: a
  // zai-org GLM-5.3 review of a zai-org GLM-5.3-Flash draft is not
  // independent). The author's route never reviews, and neither does its own
  // model family; design reviews additionally require real image input.
  const family=(routeId:string)=>{try{return findModelRoute(routeId).modelId.split('/')[0];}catch{return routeId;}};
  // Owner 2026-10-29: the looks and the screens are judged by the HOST, not by
  // a second AI. Their save already refuses an invalid theme, unreadable or
  // look-alike looks, a broken mock and a design whose checks miss an approved
  // feature; the capture above proves every state renders at phone and
  // desktop size; and the owner picks the look and approves the screens. The
  // AI visual review added 3-10 minutes per round in 4-screenshot batches and
  // ran out of output room on most design passes (Poultry Tracker: 8 calls,
  // 3 failed, 9 minutes, no verdict). Plans keep their independent review.
  const hostJudged=input.kind!=='prd';
  const eligible=hostJudged?[]:routes.filter(route=>route!==input.authorRouteId && family(route)!==family(input.authorRouteId) && (input.kind==='prd'||routeAcceptsImage(route)));
  let review:ArtifactQualityReview|undefined;
  if(hostJudged){reviewerRoute='host-checks';review={verdict:'pass',findings:[]};}
  await db.prepare("update artifact_candidates set status='reviewing' where id=? and status='pending'").bind(id).run();
  // Owner 2026-10-28: a transient provider error must not silently downgrade
  // the reviewer to a weaker fallback — the primary route is retried once, and
  // only a second failure moves the ladder down.
  for(const routeId of eligible) {
   findModelRoute(routeId);reviewerRoute=routeId;
   for(let attempt=0;attempt<2;attempt++){
    try {
     review=parseArtifactQualityReview(await bounded(signal=>input.reviewer.review({routeId,body:input.body,stage:input.kind,context,
      images,payerId:admission.payerId,operationKey:`quality:${id}:${routeId}:${attempt}`,deadlineAt:Date.parse(admission.expiresAt),signal}),REVIEW_STAGE_TIMEOUT_MS));break;
    } catch(error) {
     input.signal?.throwIfAborted();
     if(error instanceof BuildRecoveryError && error.decision.kind!=='transient-service')throw error;
     if(attempt===1)continue;
    }
   }
   if(review)break;
  }
  if(!review)throw new Error('No independent reviewer completed');
  // Owner 2026-10-29 ("we cannot afford to be waiting that long"): at most ONE
  // fix round per step. The second reviewed draft is final — it is published
  // and the reviewer's remaining findings stay on record as advisory, and the
  // owner still approves the plan, the look and the screens themselves.
  // Before this a plan took six rounds (18 min) and a design kept collecting
  // new blockers (23 on its first pass).
  const fixRounds=(await db.prepare("select count(*) n from artifact_candidates c join quality_admissions a on a.id=c.admissionId where c.projectId=? and c.kind=? and c.id<>? and c.status in ('revise','passed','published') and substr(a.dependencyHash,1,64)=?")
   .bind(input.projectId,input.kind,id,String((admission as {dependencyHash?:string}).dependencyHash??'').slice(0,64)).all<{n:number}>()).results[0]?.n??0;
  const finalRound=fixRounds>=1;
  if(finalRound && review.verdict!=='pass')review={verdict:'pass',findings:review.findings.map(row=>({...row,severity:'advisory' as const}))};
  await db.batch([
   db.prepare('insert into artifact_quality_reviews(candidateId,policyVersion,reviewerRouteId,verdict,findingsJson,captureManifestJson,createdAt) values(?,?,?,?,?,?,?)')
    .bind(id,ARTIFACT_QUALITY_POLICY,reviewerRoute,review.verdict,JSON.stringify(review.findings),JSON.stringify(images.map(({pngBase64:_,...manifest})=>manifest)),new Date().toISOString()),
   db.prepare('update artifact_candidates set status=? where id=?').bind(review.verdict==='pass'?'passed':'revise',id),
  ]);
  if(review.verdict!=='pass')throw new ScopeError(409,'QUALITY_REVISION_REQUIRED',`Fix these findings internally before presenting the revision: ${JSON.stringify(review.findings)}`);
  return {id,bodyHash};
 } catch(error) {
  if(input.signal?.aborted) {
   await db.prepare("update artifact_candidates set status='blocked' where id=? and status in ('pending','reviewing')").bind(id).run();
   input.signal.throwIfAborted();
  }
  if(error instanceof ScopeError)throw error;
  await db.prepare("update artifact_candidates set status='blocked' where id=? and status in ('pending','reviewing')").bind(id).run();
  throw new ScopeError(409,'QUALITY_UNAVAILABLE','The independent review could not finish. Earlier approved work is retained; this draft is not ready to present.');
 }
}
