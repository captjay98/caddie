import {Hono} from '../../apps/app/node_modules/hono';
import {createAcceptanceRuntimeRouter} from '../../apps/app/src/server/routes/acceptance-runtime.ts';
import {openAcceptanceCandidate} from '../../apps/app/src/server/acceptance-candidate.ts';
const api=new Hono<any>().route('/api',createAcceptanceRuntimeRouter());
import {AUTH_FILES} from '../../stacks/react-hono/auth-files.ts';
const authSql=AUTH_FILES['migrations/0000_caddie_auth.sql']!;
/** Test-only real Worker Loader gateway; production uses scoped D1 leases. */
import {runPreviewApp,bridgeRequestToRequest} from '../../apps/app/src/server/preview-runtime.ts';
import {previewDatabaseFor} from '../../apps/app/src/server/preview-database.ts';
export {PreviewDatabase,PreviewDatabaseGateway,AcceptancePlatform} from '../../apps/app/src/server/preview-database.ts';
export default {async fetch(request:Request,env:any,ctx:any){
 const path=new URL(request.url).pathname;
 if(path.startsWith('/api/'))return api.fetch(request,env,ctx);
 if(path==='/__test/init'){const {statements}=await request.json() as any;for(const sql of statements)await env.DB.prepare(sql).run();return Response.json({ok:true});}
 if(path==='/__test/candidate'){const body=await request.json() as any;return Response.json(await openAcceptanceCandidate(env.DB,{actorId:'u',workspaceId:'w',projectId:'p'},body.identity,body.bundle,new URL(request.url).origin));}
 if(path==='/__test/stop'){await env.DB.prepare("update build_workflows set phase='blocked'").run();return Response.json({ok:true});}
 if(path==='/health')return Response.json({ok:true});
 const {session,action,source,epoch,request:appRequest}=await request.json() as any;
 const projectId=`acceptance:${session}`;const db=previewDatabaseFor(env,projectId);
 if(action==='dispose'){await db.reset();return Response.json({ok:true});}
 if(action==='inbox'){await db.execScript('create table if not exists _caddie_acceptance_codes(email text primary key,code text not null)');const [row]=await db.query([{sql:'select email,code from _caddie_acceptance_codes',params:[],mode:'all'}],false);return Response.json({codes:(row as any).results});}
 await db.applyMigrations([{name:'0000_auth.sql',sql:authSql},{name:'0001_notes.sql',sql:'create table notes(owner text,body text);'}]);
 return Response.json(await runPreviewApp({loader:env.LOADER,projectId,outputId:`${session}:${epoch}`,serverSource:source,
  database:ctx.exports.PreviewDatabaseGateway({props:{projectId}}),platform:ctx.exports.AcceptancePlatform({props:{projectId}}),vars:{CADDIE_AUTH_SECRET:'local-private-acceptance-fixture-only'},globalOutbound:null,request:bridgeRequestToRequest(appRequest)}));
}};
