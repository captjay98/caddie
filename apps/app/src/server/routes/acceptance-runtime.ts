import {Hono} from 'hono';
import {createHash} from 'node:crypto';
import type {AuthEnv} from '../auth.ts';
import {ScopeError} from '../scope.ts';
import {resolveAcceptanceCandidate} from '../acceptance-candidate.ts';
import {previewDatabaseFor,runPreviewApp,bridgeRequestToRequest,type PreviewDatabaseEnv,type WorkerLoaderLike} from '../preview-runtime.ts';
/** Private scoped capability: no Caddie session or app keys enter the browser.
 * Every request rechecks the original admission, membership, expiry and quota. */
export function createAcceptanceRuntimeRouter() {
 const router=new Hono<{Bindings:AuthEnv&PreviewDatabaseEnv&{LOADER?:WorkerLoaderLike}}>();
 router.onError((error,c)=>error instanceof ScopeError?c.json({error:error.code},error.status as 400):c.json({error:'check_runtime_failed'},500));
 router.post('/acceptance-runtime',async c=>{
  const token=c.req.header('authorization')?.replace(/^Bearer /,'')??'';
  const candidate=await resolveAcceptanceCandidate(c.env.DB,token);
  const text=await c.req.text();if(text.length>1_500_000)return c.json({error:'too_large'},413);
  const input=JSON.parse(text) as {session?:string;action?:string;request?:unknown};
  if(typeof input.session!=='string'||!/^[a-zA-Z0-9:_.-]{1,150}$/.test(input.session))return c.json({error:'invalid_session'},400);
  const scope=`acceptance:${candidate.id}:${createHash('sha256').update(input.session).digest('hex')}`;
  const database=previewDatabaseFor(c.env,scope);
  if(input.action==='restart') {
   await c.env.DB.prepare('update acceptance_candidates set epoch=epoch+1 where id=?').bind(candidate.id).run();
   return c.json({restarted:true});
  }
  if(input.action==='inbox') {
   await database.execScript('create table if not exists _caddie_acceptance_codes(email text primary key,code text not null)');
   const [result]=await database.query([{sql:'select email,code from _caddie_acceptance_codes',params:[],mode:'all'}],false);
   return c.json({codes:result&&'results' in result?result.results:[]});
  }
  if(input.action==='dispose'){await database.reset();return c.json({disposed:true});}
  if(input.action!=='request')return c.json({error:'invalid_action'},400);
  if(!candidate.bundle.server)return c.json({status:404,headers:[],body:''});
  const exportsOf=(c.executionCtx as unknown as {exports?:{PreviewDatabaseGateway?:(input:{props:{projectId:string}})=>unknown;AcceptancePlatform?:(input:{props:{projectId:string}})=>unknown}}).exports;
  if(!c.env.LOADER||!exportsOf?.PreviewDatabaseGateway||!exportsOf.AcceptancePlatform)throw new ScopeError(503,'CHECK_RUNTIME_UNAVAILABLE','The isolated app check runtime is unavailable.');
  await database.applyMigrations(candidate.bundle.migrations);
  const response=await runPreviewApp({loader:c.env.LOADER,projectId:scope,outputId:`${candidate.id}:${candidate.epoch}`,serverSource:candidate.bundle.server,
   vars:{CADDIE_AUTH_SECRET:createHash('sha256').update(token).digest('hex')},database:exportsOf.PreviewDatabaseGateway({props:{projectId:scope}}),
   platform:exportsOf.AcceptancePlatform({props:{projectId:scope}}),globalOutbound:null,request:bridgeRequestToRequest(input.request)});
  return c.json(response);
 });
 return router;
}
