import {expect,test} from 'bun:test';
import { parseArtifactQualityReview } from '@caddie/contracts';
import { qualityWorld,GOOD_PLAN,BAD_PLAN } from './fixtures/artifact-quality-cases.ts';
import { qualityAdmission,reviewArtifactCandidate } from '../apps/app/src/server/artifact-quality.ts';
import { createPlanDocRevision,listPlanDocRevisions } from '../apps/app/src/server/projects.ts';
import { recordPlanDecision } from '../apps/app/src/server/planning.ts';

test('unreviewed draft never enters published revisions; exact independent pass can publish',async()=>{
 const w=await qualityWorld();try {
  await expect(createPlanDocRevision(w.db,w.scope,{kind:'prd',body:GOOD_PLAN})).rejects.toThrow();
  expect(await listPlanDocRevisions(w.db,w.scope)).toHaveLength(0);
  const routes:string[]=[];
  await reviewArtifactCandidate(w.db,{projectId:w.project.id,kind:'prd',body:GOOD_PLAN,authorRouteId:'glm-5.3-flash',reviewer:{async review(input){routes.push(input.routeId);return {verdict:'pass',findings:[]};}}});
  expect(routes).toEqual(['deepseek-v4.1-flash-1017']);
  expect(await listPlanDocRevisions(w.db,w.scope)).toHaveLength(0);
  await createPlanDocRevision(w.db,w.scope,{kind:'prd',body:GOOD_PLAN});
  expect(await listPlanDocRevisions(w.db,w.scope)).toHaveLength(1);
 }finally{w.sqlite.close();}
});
test('corrections are bounded, replay does not call again, and author cannot self-review',async()=>{
 const w=await qualityWorld();try {
  let calls=0;
  const reviewer={async review(input:{routeId:string}){calls++;expect(input.routeId).toBe('glm-5.3');return {verdict:'revise' as const,findings:[{severity:'blocking' as const,criterion:'scope',detail:'Remove self approval and specify persistent storage.'}]};}};
  const input={projectId:w.project.id,kind:'prd' as const,body:BAD_PLAN,authorRouteId:'deepseek-v4.1-flash-1017',reviewer};
  await expect(reviewArtifactCandidate(w.db,{...input,body:BAD_PLAN+'\n0'})).rejects.toThrow('Fix these findings');
  // Replaying an already-reviewed draft never calls the reviewer again.
  await expect(reviewArtifactCandidate(w.db,{...input,body:BAD_PLAN+'\n0'})).rejects.toThrow();expect(calls).toBe(1);
  // Bounded at one fix round (owner 2026-10-29): the second draft is final.
  expect(await reviewArtifactCandidate(w.db,{...input,body:BAD_PLAN+'\n1'})).toBeTruthy();expect(calls).toBe(2);
  expect(await listPlanDocRevisions(w.db,w.scope)).toHaveLength(0);
 }finally{w.sqlite.close();}
});
test('a live admission is reused as-is; an expired one grants a fresh window (no phase deadlock)',async()=>{
 const w=await qualityWorld();try {
  const a=await qualityAdmission(w.db,w.project.id,'prd');const b=await qualityAdmission(w.db,w.project.id,'prd');expect(a?.payerId).toBe(b?.payerId);expect(a?.expiresAt).toBe(b?.expiresAt);
  // Owner 2026-10-28: an expired admission used to throw QUALITY_TIME_LIMIT
  // forever (the dependency-derived id regenerated the same expired row),
  // deadlocking the planning phase. It now grants a fresh window.
  w.sqlite.prepare('update quality_admissions set expiresAt=?').run(new Date(0).toISOString());
  const fresh=await qualityAdmission(w.db,w.project.id,'prd');
  expect(fresh).not.toBeNull();
  expect(Date.parse(fresh!.expiresAt)).toBeGreaterThan(Date.now());
 }finally{w.sqlite.close();}
});
test('the reviewer is shown the owner\'s own recorded change request and whether the plan in force was ever approved',async()=>{
 // Street Food Share, 2026-10-28: the owner asked in their own words for AI
 // features after the first PRD was written. The reviewer only ever saw the
 // earlier plan, so it refused every AI-bearing revision as "scope
 // inconsistency" and told itself "candidate text is not evidence" — an
 // owner-authorized change was unprovable by construction.
 const w=await qualityWorld();try {
  await reviewArtifactCandidate(w.db,{projectId:w.project.id,kind:'prd',body:GOOD_PLAN,authorRouteId:'deepseek-v4.1-flash-1017',reviewer:{async review(){return {verdict:'pass' as const,findings:[]};}}});
  await createPlanDocRevision(w.db,w.scope,{kind:'prd',body:GOOD_PLAN});
  const inForce=(await listPlanDocRevisions(w.db,w.scope,'prd'))[0]!;
  w.sqlite.prepare('update build_workflows set planId=? where projectId=?').run(inForce.id,w.project.id);
  await recordPlanDecision(w.db,w.scope,{planRevisionId:inForce.id,decision:'changes',note:'put it in the Nebius hackathon — my app can use AI'});
  let context='';
  await reviewArtifactCandidate(w.db,{projectId:w.project.id,kind:'prd',body:GOOD_PLAN+'\n\nThe app can use AI to suggest what to cook.',authorRouteId:'deepseek-v4.1-flash-1017',reviewer:{async review(input){context=input.context;return {verdict:'pass' as const,findings:[]};}}});
  expect(context).toContain('my app can use AI');
  expect(context).toContain('not approved');
 }finally{w.sqlite.close();}
});
test('schema rejects a passing review containing blocking findings',()=>{
 expect(()=>parseArtifactQualityReview({verdict:'pass',findings:[{severity:'blocking',criterion:'missing',detail:'The flow is missing'}]})).toThrow();
});
test('an interrupted review cannot remain indefinitely marked as reviewing',async()=>{
 const w=await qualityWorld();try {
  const controller=new AbortController();
  await expect(reviewArtifactCandidate(w.db,{projectId:w.project.id,kind:'prd',body:GOOD_PLAN,authorRouteId:'deepseek-v4.1-flash-1017',signal:controller.signal,reviewer:{async review(){controller.abort(new Error('Interrupted'));throw new Error('Interrupted');}}})).rejects.toThrow('Interrupted');
  const candidate=w.sqlite.query("select status from artifact_candidates where projectId=?").get(w.project.id) as {status:string};
  expect(candidate.status).toBe('blocked');
  expect(await listPlanDocRevisions(w.db,w.scope)).toHaveLength(0);
 }finally{w.sqlite.close();}
});
