import {expect,test} from 'bun:test';
import { qualityWorld,GOOD_PLAN } from './fixtures/artifact-quality-cases.ts';
import {reviewArtifactCandidate} from '../apps/app/src/server/artifact-quality.ts';
import {createPlanDocRevision,listPlanDocRevisions} from '../apps/app/src/server/projects.ts';

test('a changed dependency fences a late passing reviewer at the real publication INSERT',async()=>{
 const w=await qualityWorld();try {
  await reviewArtifactCandidate(w.db,{projectId:w.project.id,kind:'prd',body:GOOD_PLAN,authorRouteId:'glm-5.3-flash',reviewer:{async review(){w.sqlite.prepare('update build_workflows set brief=?').run('The user changed the scope.');return {verdict:'pass',findings:[]};}}});
  await expect(createPlanDocRevision(w.db,w.scope,{kind:'prd',body:GOOD_PLAN})).rejects.toThrow();
  expect(await listPlanDocRevisions(w.db,w.scope)).toHaveLength(0);
 }finally{w.sqlite.close();}
});
test('a newer intended candidate fences an older passing candidate, while published history survives',async()=>{
 const w=await qualityWorld(false);try {
  const old=await createPlanDocRevision(w.db,w.scope,{kind:'prd',body:'Previously approved original content.'});
  const {admitQualityProject}=await import('../apps/app/src/server/artifact-quality.ts');
  await admitQualityProject(w.db,w.project.id,{CADDIE_QUALITY_POLICY:'quality-v1'});
  const base={projectId:w.project.id,kind:'prd' as const,authorRouteId:'glm-5.3-flash',reviewer:{async review(){return {verdict:'pass' as const,findings:[]};}}};
  await reviewArtifactCandidate(w.db,{...base,body:GOOD_PLAN});
  await reviewArtifactCandidate(w.db,{...base,body:GOOD_PLAN+'\nA clearer version.'});
  await expect(createPlanDocRevision(w.db,w.scope,{kind:'prd',body:GOOD_PLAN})).rejects.toThrow();
  expect((await listPlanDocRevisions(w.db,w.scope))[0]?.id).toBe(old.id);
  await createPlanDocRevision(w.db,w.scope,{kind:'prd',body:GOOD_PLAN+'\nA clearer version.'});
  expect(await listPlanDocRevisions(w.db,w.scope)).toHaveLength(2);
 }finally{w.sqlite.close();}
});
test('missing browser capture cannot become a design pass or call a text reviewer',async()=>{
 const w=await qualityWorld();try {
  w.sqlite.exec("update build_workflows set phase='design'");let called=false;
  await expect(reviewArtifactCandidate(w.db,{projectId:w.project.id,kind:'design',body:'Design draft',authorRouteId:'glm-5.3-flash',reviewer:{async review(){called=true;return {verdict:'pass',findings:[]};}}})).rejects.toThrow('independent review');
  expect(called).toBe(false);expect(await listPlanDocRevisions(w.db,w.scope)).toHaveLength(0);
 }finally{w.sqlite.close();}
});
