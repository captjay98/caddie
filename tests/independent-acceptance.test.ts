import {expect,test} from 'bun:test';
import {qualityWorld} from './fixtures/artifact-quality-cases.ts';
import {criterionHash,runIndependentAcceptance,validateAcceptanceResult,type AcceptanceIdentity} from '../apps/app/src/server/independent-acceptance.ts';
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
