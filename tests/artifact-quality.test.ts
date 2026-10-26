import {expect,test} from 'bun:test';
import { parseArtifactQualityReview } from '@caddie/contracts';
import { qualityWorld,GOOD_PLAN,BAD_PLAN } from './fixtures/artifact-quality-cases.ts';
import { qualityAdmission,reviewArtifactCandidate } from '../apps/app/src/server/artifact-quality.ts';
import { createPlanDocRevision,listPlanDocRevisions } from '../apps/app/src/server/projects.ts';

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
  for(let i=0;i<3;i++)await expect(reviewArtifactCandidate(w.db,{...input,body:BAD_PLAN+'\n'+i})).rejects.toThrow('Fix these findings');
  await expect(reviewArtifactCandidate(w.db,{...input,body:BAD_PLAN+'\n0'})).rejects.toThrow();expect(calls).toBe(3);
  await expect(reviewArtifactCandidate(w.db,{...input,body:BAD_PLAN+'\n4'})).rejects.toThrow('allowance');expect(calls).toBe(3);
  expect(await listPlanDocRevisions(w.db,w.scope)).toHaveLength(0);
 }finally{w.sqlite.close();}
});
test('fresh context keeps the preparation deadline and payer',async()=>{
 const w=await qualityWorld();try {
  const a=await qualityAdmission(w.db,w.project.id,'prd');const b=await qualityAdmission(w.db,w.project.id,'prd');expect(a?.payerId).toBe(b?.payerId);expect(a?.expiresAt).toBe(b?.expiresAt);
  w.sqlite.prepare('update quality_admissions set expiresAt=?').run(new Date(0).toISOString());
  await expect(qualityAdmission(w.db,w.project.id,'prd')).rejects.toThrow('allowance');
 }finally{w.sqlite.close();}
});
test('schema rejects a passing review containing blocking findings',()=>{
 expect(()=>parseArtifactQualityReview({verdict:'pass',findings:[{severity:'blocking',criterion:'missing',detail:'The flow is missing'}]})).toThrow();
});
