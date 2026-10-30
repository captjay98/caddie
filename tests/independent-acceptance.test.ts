import {expect,test} from 'bun:test';
import {ACCEPTANCE_JOURNEY_GUIDE,HASH_ROUTES_RULE,JOURNEY_EMPTY_START_RULE} from '@caddie/contracts';
import {qualityWorld} from './fixtures/artifact-quality-cases.ts';
import {acceptanceFailures,acceptanceRepairBrief,criterionHash,describeJourney,EMPTY_START_RULE,runIndependentAcceptance,SIGN_IN_JOURNEY_RULE,validateAcceptanceResult,type AcceptanceIdentity} from '../apps/app/src/server/independent-acceptance.ts';
const identity:AcceptanceIdentity={projectId:'p',runId:'r',admissionId:'payer',planId:'plan',designId:'design',featureId:'f',checkedImage:'checked-image'};
const criteria=[{featureId:'old',text:'Saved entries survive restart'},{featureId:'f',text:'An offline entry syncs when reconnected'}];
const result=()=>({identity:{...identity},checks:criteria.map(criterion=>({criterionHash:criterionHash(criterion),passed:true,evidenceId:'host-runtime-evidence'}))});
test('independent acceptance covers prior and current exact criteria on the checked revision',()=>{
 expect(validateAcceptanceResult(identity,criteria,result())).toBe(true);
 expect(()=>validateAcceptanceResult(identity,criteria,{...result(),identity:{...identity,checkedImage:'stale'}})).toThrow();
 expect(()=>validateAcceptanceResult(identity,criteria,{...result(),checks:result().checks.slice(0,1)})).toThrow();
 expect(()=>validateAcceptanceResult(identity,criteria,{...result(),checks:[result().checks[0]!,result().checks[0]!]})).toThrow();
 const failed=result();failed.checks[1]!.passed=false;expect(validateAcceptanceResult(identity,criteria,failed)).toBe(false);
});
test('missing independent runtime infrastructure is not a pass and exact receipts replay without a new check',async()=>{
 const w=await qualityWorld();try {
  const actual={...identity,projectId:w.project.id};let calls=0;
  const absent=await runIndependentAcceptance(w.db,{identity:actual,criteria,operationKey:'missing'});expect(absent.status).toBe('not-checked');
  const input={identity:actual,criteria,operationKey:'checked',port:{async check(){calls++;return {...result(),identity:actual};}}};
  expect((await runIndependentAcceptance(w.db,input)).status).toBe('passed');expect((await runIndependentAcceptance(w.db,input)).status).toBe('passed');expect(calls).toBe(1);
  await expect(runIndependentAcceptance(w.db,{...input,identity:{...actual,admissionId:'later'}})).rejects.toThrow();
 }finally{w.sqlite.close();}
});
test('concurrent replay cannot execute a second independent check',async()=>{
 const w=await qualityWorld();try{
  let release!:()=>void;let calls=0;
  const actual={...identity,projectId:w.project.id};
  const port={async check(){calls++;await new Promise<void>(resolve=>{release=resolve;});return {...result(),identity:actual};}};
  const first=runIndependentAcceptance(w.db,{identity:actual,criteria,operationKey:'concurrent',port});
  await Bun.sleep(1);await expect(runIndependentAcceptance(w.db,{identity:actual,criteria,operationKey:'concurrent',port})).rejects.toThrow('already executing');
  release();expect((await first).status).toBe('passed');expect(calls).toBe(1);
 }finally{w.sqlite.close();}
});
// 2026-10-30 EggOps run: all four start-farm checks failed at the sign-in
// field, but the repair was told only "independent criteria failed".
const playwrightReason="fill: Timeout 10000ms exceeded.\nCall log:\n  - waiting for getByLabel('Email', { exact: true })\n";
test('failed checks carry the checker reason into the repair brief, with the host steps and the sign-in rule',async()=>{
 const failed=result();failed.checks[1]!.passed=false;(failed.checks[1] as {reason?:string}).reason=playwrightReason;
 expect(validateAcceptanceResult(identity,criteria,failed)).toBe(false);
 expect(()=>validateAcceptanceResult(identity,criteria,{...failed,checks:[failed.checks[0]!,{...failed.checks[1]!,reason:42 as unknown as string}]})).toThrow();
 const failures=acceptanceFailures(criteria,failed);
 expect(failures).toEqual([{featureId:'f',text:'An offline entry syncs when reconnected',reason:"fill: Timeout 10000ms exceeded. Call log: - waiting for getByLabel('Email', { exact: true })"}]);
 const journeys={version:1 as const,criteria:[{featureId:'f',text:'An offline entry syncs when reconnected',steps:[{kind:'open' as const,path:'/farm'},{kind:'actor' as const,user:'a' as const},{kind:'fill' as const,label:'Flock name',value:'Pen 2'},{kind:'click' as const,name:'Save'},{kind:'reload' as const},{kind:'expect' as const,text:'Pen 2',visible:true}]}],states:[{title:'x',steps:[{kind:'open' as const,path:'/'}]}]};
 const brief=acceptanceRepairBrief(failures,journeys);
 expect(brief).toContain('“An offline entry syncs when reconnected”');
 expect(brief).toContain('open "#/farm" → sign in as person A → fill the field labelled "Flock name" with "Pen 2" → press "Save" → reload the page → expect "Pen 2" to show');
 expect(brief).toContain("It broke at: fill: Timeout 10000ms exceeded. (waiting for getByLabel('Email', { exact: true }))");
 expect(brief).toContain(SIGN_IN_JOURNEY_RULE);
 // The same run's app routed by location.pathname, so "open /farm" never left the welcome screen.
 expect(brief).toContain(HASH_ROUTES_RULE);
 // Each check runs in a fresh database, and the rules lead so a cut never drops them.
 expect(brief.startsWith(`The host's independent checks failed (1). ${EMPTY_START_RULE} ${HASH_ROUTES_RULE} ${SIGN_IN_JOURNEY_RULE}\n1. `)).toBe(true);
 // Playwright's colour codes are stripped before the builder reads them.
 const coloured=result();coloured.checks[0]!.passed=false;(coloured.checks[0] as {reason?:string}).reason="waiting for getByLabel('Email')\u001b[22m";
 expect(acceptanceFailures(criteria,coloured)[0]!.reason).toBe("waiting for getByLabel('Email')");
 expect(describeJourney([{kind:'expect',text:'Pen 1',visible:false}])).toBe('expect "Pen 1" not to show');
 // A failure that is not about signing in does not get the sign-in rule.
 expect(acceptanceRepairBrief([{featureId:'f',text:'t',reason:'expect(locator).toBeVisible() failed'}],undefined)).not.toContain('SignIn');
 // A check that saves nothing is told it runs on an empty account (EggOps "See all days → 205").
 expect(brief).not.toContain('Nothing is typed or saved');
 const emptyBrief=acceptanceRepairBrief([{featureId:'f',text:'An offline entry syncs when reconnected',reason:'expect(locator).toBeVisible() failed'}],{...journeys,criteria:[{featureId:'f',text:'An offline entry syncs when reconnected',steps:[{kind:'open',path:'/farm'},{kind:'actor',user:'a'},{kind:'click',name:'See all days'},{kind:'expect',text:'205',visible:true}]}]});
 expect(emptyBrief).toContain('Nothing is typed or saved in this check');
 expect(JOURNEY_EMPTY_START_RULE).toContain('ALONE on an empty app');
 expect(ACCEPTANCE_JOURNEY_GUIDE).toContain(JOURNEY_EMPTY_START_RULE);
 // No recorded reason still points the repair at the approved steps rather than guessing.
 expect(acceptanceRepairBrief([],undefined)).toContain('caddie-checks steps');
});
test('a failed receipt replays its failures so a resumed build still knows what broke',async()=>{
 const w=await qualityWorld();try {
  const actual={...identity,projectId:w.project.id};
  const port={async check(){const r={...result(),identity:actual};r.checks[0]!.passed=false;(r.checks[0] as {reason?:string}).reason='The isolated app did not load';return r;}};
  const first=await runIndependentAcceptance(w.db,{identity:actual,criteria,operationKey:'failed-replay',port});
  expect(first.status).toBe('failed');expect(first.failures).toEqual([{featureId:'old',text:'Saved entries survive restart',reason:'The isolated app did not load'}]);
  const replay=await runIndependentAcceptance(w.db,{identity:actual,criteria,operationKey:'failed-replay',port});
  expect(replay.failures).toEqual(first.failures);
 }finally{w.sqlite.close();}
});
