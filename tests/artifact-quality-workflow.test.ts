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
test('every new project is admitted to the quality gate with no env anywhere (owner 2026-10-27: default-on)',async()=>{
 const w=await qualityWorld(false);try {
  // qualityWorld(false) no longer means "unadmitted": admission rides
  // ensureWorkflow at creation and ignores the environment entirely.
  const rows=w.sqlite.query('select count(*) as n from quality_projects where projectId=?').get(w.project.id) as {n:number};
  expect(rows.n).toBe(1);
 }finally{w.sqlite.close();}
});
test('a newer intended candidate fences an older passing candidate, while published history survives',async()=>{
 const w=await qualityWorld();try {
  const base={projectId:w.project.id,kind:'prd' as const,authorRouteId:'glm-5.3-flash',reviewer:{async review(){return {verdict:'pass' as const,findings:[]};}}};
  // Round 1 passes and is published; round 2 becomes the newest intended
  // candidate, fencing the older one from being published afterwards.
  await reviewArtifactCandidate(w.db,{...base,body:GOOD_PLAN});
  const old=await createPlanDocRevision(w.db,w.scope,{kind:'prd',body:GOOD_PLAN});
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

// Poultry Farm Monitor, 2026-10-29: the screenshot checker was down, three
// looks rounds were 'blocked' without any review, and the owner's retry then
// failed at once on the three-round cap.
test('rounds the review could not run do not use up the three reviewed tries',async()=>{
 const w=await qualityWorld();try {
  const broken={async review():Promise<never>{throw new Error('provider unreachable');}};
  for(let i=0;i<3;i++)await expect(reviewArtifactCandidate(w.db,{projectId:w.project.id,kind:'prd',body:GOOD_PLAN+'\n'+i,authorRouteId:'glm-5.3-flash',reviewer:broken})).rejects.toThrow('independent review');
  let reviewed=0;
  await reviewArtifactCandidate(w.db,{projectId:w.project.id,kind:'prd',body:GOOD_PLAN+'\nretry',authorRouteId:'glm-5.3-flash',reviewer:{async review(){reviewed++;return {verdict:'pass' as const,findings:[]};}}});
  expect(reviewed).toBe(1);
 }finally{w.sqlite.close();}
});


test('a revision is reviewed with the reviewer\'s own earlier findings in its context',async()=>{
 const w=await qualityWorld();try {
  const contexts:string[]=[];
  const reviewer={async review(input:{context:string}){contexts.push(input.context);return contexts.length===1
   ?{verdict:'revise' as const,findings:[{severity:'blocking' as const,criterion:'setup',detail:'Add the first-farm setup journey.'}]}
   :{verdict:'pass' as const,findings:[]};}};
  const input={projectId:w.project.id,kind:'prd' as const,authorRouteId:'deepseek-v4.1-flash-1017',reviewer};
  await expect(reviewArtifactCandidate(w.db,{...input,body:GOOD_PLAN+'\nA'})).rejects.toThrow('Fix these findings');
  await reviewArtifactCandidate(w.db,{...input,body:GOOD_PLAN+'\nB'});
  expect(JSON.parse(contexts[0]!).yourEarlierFindings).toBeUndefined();
  expect(JSON.parse(contexts[1]!).yourEarlierFindings).toEqual([{severity:'blocking',criterion:'setup',detail:'Add the first-farm setup journey.'}]);
 }finally{w.sqlite.close();}
});

// Owner 2026-10-29: one fix round per step; the second reviewed draft is final.
test('the second reviewed draft is published with the remaining findings as advisory',async()=>{
 const w=await qualityWorld();try {
  let reviews=0;
  const strict={async review(){reviews++;return {verdict:'revise' as const,findings:[{severity:'blocking' as const,criterion:'scope',detail:'Still not perfect.'}]};}};
  const input={projectId:w.project.id,kind:'prd' as const,authorRouteId:'deepseek-v4.1-flash-1017',reviewer:strict};
  await expect(reviewArtifactCandidate(w.db,{...input,body:GOOD_PLAN+'\nfirst'})).rejects.toThrow('Fix these findings');
  const second=await reviewArtifactCandidate(w.db,{...input,body:GOOD_PLAN+'\nsecond'});
  expect(second?.id).toBeTruthy();expect(reviews).toBe(2);
  const stored=w.sqlite.query("select r.verdict, r.findingsJson from artifact_quality_reviews r where r.candidateId=?").get(second!.id) as {verdict:string;findingsJson:string};
  expect(stored.verdict).toBe('pass');expect(JSON.parse(stored.findingsJson)[0].severity).toBe('advisory');
 }finally{w.sqlite.close();}
});

// Owner 2026-10-29: looks and screens are judged by the host checks, the real
// screenshot capture and the owner — no second AI.
test('a design that renders is published on host checks without an AI review',async()=>{
 const w=await qualityWorld();try {
  w.sqlite.exec("update build_workflows set phase='design'");let reviewed=false;let captured=0;
  const {createHash}=await import('node:crypto');
  const png=(width:number,height:number)=>{const b=Buffer.alloc(67);Buffer.from([137,80,78,71,13,10,26,10]).copy(b,0);b.write('IHDR',12,'ascii');b.writeUInt32BE(width,16);b.writeUInt32BE(height,20);b.write('IEND',59,'ascii');return b;};
  const states=[{id:'s1',document:'<main>Today</main>'}];
  const capture={async capture(list:readonly {id:string;document:string}[]){captured++;return list.flatMap(state=>(['phone','desktop'] as const).map(viewport=>{const [width,height]=viewport==='phone'?[390,844]:[1440,900];const bytes=png(width!,height!);
   return {stateId:state.id,viewport,width:width!,height:height!,documentHash:createHash('sha256').update(state.document).digest('hex'),pngSha256:createHash('sha256').update(bytes).digest('hex'),pngBase64:bytes.toString('base64')};}));}};
  const result=await reviewArtifactCandidate(w.db,{projectId:w.project.id,kind:'design',body:'Design draft',authorRouteId:'minimax-m3.1-flash',states,capture,
   reviewer:{async review(){reviewed=true;return {verdict:'revise' as const,findings:[]};}}});
  expect(result?.id).toBeTruthy();expect(captured).toBe(1);expect(reviewed).toBe(false);
  expect(w.sqlite.query("select reviewerRouteId, verdict from artifact_quality_reviews").get()).toEqual({reviewerRouteId:'host-checks',verdict:'pass'});
 }finally{w.sqlite.close();}
});
