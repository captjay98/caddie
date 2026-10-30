import {expect,test} from 'bun:test';
import {qualityWorld,GOOD_PLAN} from './fixtures/artifact-quality-cases.ts';
import {qualityAdmission} from '../apps/app/src/server/artifact-quality.ts';
import {nebiusQualityReviewer} from '../apps/app/src/server/artifact-quality-model.ts';
import {resolveTurnPayer} from '../apps/app/src/server/spend-instrument.ts';
test('author and independent reviewer share a bounded preparation payer; every physical call is priced',async()=>{
 const w=await qualityWorld();try {
  const payer=await resolveTurnPayer(w.db,{instanceId:w.workflow.conversationId} as Parameters<typeof resolveTurnPayer>[1]);
  const admission=await qualityAdmission(w.db,w.project.id,'prd');expect(payer).toBe(admission!.payerId);
  let calls=0;
  const reviewer=nebiusQualityReviewer(w.db,'not-a-real-key',(async(_url,request)=>{
   calls++;const body=JSON.parse(String(request?.body));expect(body.model).toBe('deepseek-ai/DeepSeek-V4.1-Flash-1017');expect(body.tools).toBeUndefined();
   return Response.json({model:body.model,choices:[{message:{content:JSON.stringify({verdict:'pass',findings:[]})}}],usage:{prompt_tokens:100,completion_tokens:50,total_tokens:150}});
  }) as typeof fetch);
  const input={routeId:'deepseek-v4.1-flash-1017',body:GOOD_PLAN,context:'Farm log',images:[],payerId:payer!,operationKey:'checked-review',deadlineAt:Date.now()+60_000};
  expect((await reviewer.review(input)).verdict).toBe('pass');expect(calls).toBe(1);
  const usage=w.sqlite.query('select requestedModel,catalogCostMicros,purpose from model_call_usage').get();
  expect(usage).toEqual({requestedModel:'deepseek-ai/DeepSeek-V4.1-Flash-1017',catalogCostMicros:90,purpose:'plan_quality_review'});
  await expect(reviewer.review(input)).rejects.toThrow('already issued');expect(calls).toBe(1);
 }finally{w.sqlite.close();}
});
// Each part gets ONE fresh, separately reserved retry (2026-10-29: single
// dropped parts failed whole design rounds); the same operation is still never
// blindly replayed, and an unknown outcome keeps its reservation.
test('unknown provider outcome retains its reservation and cannot be blindly replayed',async()=>{
 const w=await qualityWorld();try {
  const admission=await qualityAdmission(w.db,w.project.id,'prd');let calls=0;
  const reviewer=nebiusQualityReviewer(w.db,'not-a-real-key',(async()=>{calls++;throw new TypeError('socket reset');}) as unknown as typeof fetch);
  const input={routeId:'deepseek-v4.1-flash-1017',body:GOOD_PLAN,context:'Farm log',images:[],payerId:admission!.payerId,operationKey:'unknown-review',deadlineAt:Date.now()+60_000};
  await expect(reviewer.review(input)).rejects.toThrow();expect(calls).toBe(2);
  await expect(reviewer.review(input)).rejects.toThrow();expect(calls).toBe(2);
  expect(w.sqlite.query('select status,settledMicros from build_spend_reservations').all()).toEqual([{status:'reserved',settledMicros:null},{status:'reserved',settledMicros:null}]);
  expect(w.sqlite.query('select catalogCostMicros,isError from model_call_usage').all()).toEqual([{catalogCostMicros:null,isError:1},{catalogCostMicros:null,isError:1}]);
 }finally{w.sqlite.close();}
});
test('a part that fails once and then answers counts as reviewed',async()=>{
 const w=await qualityWorld();try {
  const admission=await qualityAdmission(w.db,w.project.id,'prd');let calls=0;
  const reviewer=nebiusQualityReviewer(w.db,'not-a-real-key',(async(_url:unknown,request?:RequestInit)=>{calls++;if(calls===1)throw new TypeError('Network connection lost.');
   const body=JSON.parse(String(request?.body));return Response.json({model:body.model,choices:[{message:{content:JSON.stringify({verdict:'pass',findings:[]})}}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}});}) as unknown as typeof fetch);
  const input={routeId:'deepseek-v4.1-flash-1017',body:GOOD_PLAN,context:'Farm log',images:[],payerId:admission!.payerId,operationKey:'flaky-review',deadlineAt:Date.now()+60_000};
  expect((await reviewer.review(input)).verdict).toBe('pass');expect(calls).toBe(2);
 }finally{w.sqlite.close();}
});
// Owner 2026-10-29: the author is told exactly what the reviewer judges.
// Owner 2026-10-29: screens are machine-checked, so the designer carries one
// short prompt and the example, not the AI reviewer's checklists.
test('the designer carries one short prompt with the example; the legacy design reviewer prompt is unchanged',async()=>{
 const {SPECIALIST_INSTRUCTIONS}=await import('../apps/app/src/agents/specialists.ts');
 const {DESIGN_REVIEW_CRITERIA,LOOKS_REVIEW_CRITERIA,DESIGN_REVIEW_NOT_JUDGED,LOOKS_BLOCK_GUIDE,reviewChecklist}=await import('@caddie/contracts');
 expect(SPECIALIST_INSTRUCTIONS.designer).toContain(LOOKS_BLOCK_GUIDE);
 expect(SPECIALIST_INSTRUCTIONS.designer).not.toContain(reviewChecklist(LOOKS_REVIEW_CRITERIA));
 expect(SPECIALIST_INSTRUCTIONS.designer.length).toBeLessThan(LOOKS_BLOCK_GUIDE.length+2500);
 const w=await qualityWorld();try {
  const admission=await qualityAdmission(w.db,w.project.id,'prd');let system='';let effort='';
  const reviewer=nebiusQualityReviewer(w.db,'not-a-real-key',(async(_url:unknown,request?:RequestInit)=>{const body=JSON.parse(String(request?.body));system=body.messages[0].content;effort=body.reasoning_effort;
   return Response.json({model:body.model,choices:[{message:{content:JSON.stringify({verdict:'pass',findings:[]})}}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}});}) as unknown as typeof fetch);
  await reviewer.review({routeId:'deepseek-v4.1-flash-1017',stage:'design',body:'design',context:'Farm log',images:[],payerId:admission!.payerId,operationKey:'design-scope',deadlineAt:Date.now()+60_000});
  expect(system).toContain(reviewChecklist(DESIGN_REVIEW_CRITERIA));expect(system).toContain(DESIGN_REVIEW_NOT_JUDGED);expect(effort).toBe('medium');
 }finally{w.sqlite.close();}
});
// Poultry Tracker, 2026-10-29: three plan rounds blocked on "contest AI
// requirement unsubstantiated" while the plan was forbidden to name the model.
test('the plan author and plan reviewer share one checklist and the platform AI fact',async()=>{
 const {SPECIALIST_INSTRUCTIONS}=await import('../apps/app/src/agents/specialists.ts');
 const {PRD_REVIEW_CRITERIA,PLATFORM_AI_FACT,reviewChecklist}=await import('@caddie/contracts');
 expect(SPECIALIST_INSTRUCTIONS.product).toContain(reviewChecklist(PRD_REVIEW_CRITERIA));
 expect(SPECIALIST_INSTRUCTIONS.product).toContain(PLATFORM_AI_FACT);
 const w=await qualityWorld();try {
  const admission=await qualityAdmission(w.db,w.project.id,'prd');let system='';let effort='';
  const reviewer=nebiusQualityReviewer(w.db,'not-a-real-key',(async(_url:unknown,request?:RequestInit)=>{const body=JSON.parse(String(request?.body));system=body.messages[0].content;effort=body.reasoning_effort;
   return Response.json({model:body.model,choices:[{message:{content:JSON.stringify({verdict:'pass',findings:[]})}}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}});}) as unknown as typeof fetch);
  await reviewer.review({routeId:'glm-5.3',stage:'prd',body:GOOD_PLAN,context:'Farm log',images:[],payerId:admission!.payerId,operationKey:'prd-scope',deadlineAt:Date.now()+60_000});
  expect(system).toContain(reviewChecklist(PRD_REVIEW_CRITERIA));expect(system).toContain(PLATFORM_AI_FACT);expect(effort).toBe('max');
  const {REVIEW_STABILITY_RULE}=await import('@caddie/contracts');expect(system).toContain(REVIEW_STABILITY_RULE);
 }finally{w.sqlite.close();}
});
