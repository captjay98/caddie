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
test('unknown provider outcome retains its reservation and cannot be blindly replayed',async()=>{
 const w=await qualityWorld();try {
  const admission=await qualityAdmission(w.db,w.project.id,'prd');let calls=0;
  const reviewer=nebiusQualityReviewer(w.db,'not-a-real-key',(async()=>{calls++;throw new TypeError('socket reset');}) as unknown as typeof fetch);
  const input={routeId:'deepseek-v4.1-flash-1017',body:GOOD_PLAN,context:'Farm log',images:[],payerId:admission!.payerId,operationKey:'unknown-review',deadlineAt:Date.now()+60_000};
  await expect(reviewer.review(input)).rejects.toThrow();await expect(reviewer.review(input)).rejects.toThrow();expect(calls).toBe(1);
  expect(w.sqlite.query('select status,settledMicros from build_spend_reservations').get()).toEqual({status:'reserved',settledMicros:null});
  expect(w.sqlite.query('select catalogCostMicros,isError from model_call_usage').get()).toEqual({catalogCostMicros:null,isError:1});
 }finally{w.sqlite.close();}
});
