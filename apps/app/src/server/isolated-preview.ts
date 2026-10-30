import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {Buffer} from 'node:buffer';
import type {Scope} from '@caddie/contracts';
import type {AuthEnv} from './auth.ts';
import {assertProjectScope,ScopeError} from './scope.ts';
import {readBuildOutput,readOutputManifest} from './build-workflow.ts';
import {previewDocument} from '../shared/preview-frame.ts';
import {createD1ContentStore} from './artifacts.ts';
import {previewSeed} from '../shared/preview-frame.ts';

export const PREVIEW_LAUNCH_TTL=10*60_000;
export interface PreviewLaunch extends Scope {
 origin:string;parentOrigin:string;outputId:string;nonce:string;expiresAt:number;seedRef?:string;
}
export type IsolatedPreviewEnv=Pick<AuthEnv,'DB'|'BETTER_AUTH_URL'>&{BETTER_AUTH_SECRET?:string;PREVIEW_BASE_URL?:string;PREVIEW_SIGNING_SECRET?:string};
export function previewSigningSecret(env:Pick<IsolatedPreviewEnv,'BETTER_AUTH_URL'|'BETTER_AUTH_SECRET'|'PREVIEW_SIGNING_SECRET'>):string {
 if(env.PREVIEW_SIGNING_SECRET&&env.PREVIEW_SIGNING_SECRET.length>=32)return env.PREVIEW_SIGNING_SECRET;
 if(['localhost','127.0.0.1','[::1]'].includes(new URL(env.BETTER_AUTH_URL).hostname)&&env.BETTER_AUTH_SECRET)
  return createHmac('sha256',env.BETTER_AUTH_SECRET).update('caddie-preview-signing-v1').digest('hex');
 throw new ScopeError(503,'PREVIEW_ORIGIN_UNAVAILABLE','The preview signing key is not configured.');
}
export function previewBase(configured:string|undefined,appOrigin:string):string {
 const app=new URL(appOrigin);
 const local=['localhost','127.0.0.1','[::1]'].includes(app.hostname);
 if(!configured&&!local)throw new ScopeError(503,'PREVIEW_ORIGIN_UNAVAILABLE','The isolated preview address is not configured.');
 const url=new URL(configured??`http://preview.localhost:${app.port||'5176'}`);
 if(url.origin===app.origin||url.hostname===app.hostname||app.hostname.endsWith(`.${url.hostname}`)||url.hostname.endsWith(`.${app.hostname}`)&&!local||url.username||url.password||url.search||url.hash||url.pathname!=='/'||
  !(url.protocol==='https:'||url.protocol==='http:'&&url.hostname.endsWith('.localhost')&&local)) {
  throw new ScopeError(503,'PREVIEW_ORIGIN_UNAVAILABLE','A separate preview origin is required.');
 }
 return url.origin;
}
export function previewOrigin(base:string,scope:Pick<Scope,'actorId'|'projectId'>):string {
 const url=new URL(base);
 const label=createHash('sha256').update(JSON.stringify([scope.actorId,scope.projectId])).digest('hex').slice(0,24);
 url.hostname=`p-${label}.${url.hostname}`;return url.origin;
}
export function signPreviewLaunch(secret:string,claims:PreviewLaunch):string {
 const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');
 return payload+'.'+createHmac('sha256',secret).update('preview-launch-v1:'+payload).digest('base64url');
}
export function verifyPreviewLaunch(secret:string,token:string,origin:string,now=Date.now()):PreviewLaunch {
 const denied=()=>new ScopeError(404,'PREVIEW_GONE','This preview link has expired or is unavailable. Open it again from your project.');
 if(token.length>4096)throw denied();
 const [payload,signature,...extra]=token.split('.');
 if(!payload||!signature||extra.length)throw denied();
 const expected=createHmac('sha256',secret).update('preview-launch-v1:'+payload).digest('base64url');
 if(signature.length!==expected.length||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))throw denied();
 let claims:PreviewLaunch;
 try{claims=JSON.parse(Buffer.from(payload,'base64url').toString());}catch{throw denied();}
 if(!claims||!['actorId','workspaceId','projectId','outputId','nonce','parentOrigin','origin'].every(k=>typeof (claims as unknown as Record<string,unknown>)[k]==='string')||
  !Number.isSafeInteger(claims.expiresAt)||claims.expiresAt<=now||claims.expiresAt>now+PREVIEW_LAUNCH_TTL||claims.origin!==origin)throw denied();
 return claims;
}
export function createPreviewLaunch(env:IsolatedPreviewEnv,scope:Scope,outputId:string,nonce:string,parentOrigin:string,seedRef?:string) {
 const origin=previewOrigin(previewBase(env.PREVIEW_BASE_URL,parentOrigin),scope);
 const ticket=signPreviewLaunch(previewSigningSecret(env),{...scope,outputId,nonce,parentOrigin,origin,expiresAt:Date.now()+PREVIEW_LAUNCH_TTL,...(seedRef?{seedRef}:{})});
 const url=new URL('/api/isolated-preview/document',origin);url.searchParams.set('ticket',ticket);
 const reset=new URL(url);reset.pathname='/api/isolated-preview/clear';
 return {url:url.href,origin,resetUrl:reset.href};
}
/** Host firewall: a preview host must NEVER fall through to Caddie APIs or
 * SPA assets. Authenticated launch is on Caddie's host; only a signed scoped
 * document is served here. No Caddie cookie is read on this boundary. */
export async function isolatedPreviewRequest(request:Request,env:IsolatedPreviewEnv):Promise<Response|null> {
 const url=new URL(request.url);
 const reserved=/^p-[a-f0-9]{24}\./.test(url.hostname);
 const appOrigin=new URL(env.BETTER_AUTH_URL).origin;
 let base:string;
 try{base=previewBase(env.PREVIEW_BASE_URL,appOrigin);}catch{return reserved?new Response('Not found',{status:404}):null;}
 const baseHost=new URL(base).hostname;
 if(url.hostname!==baseHost&&!url.hostname.endsWith('.'+baseHost))return reserved?new Response('Not found',{status:404}):null;
 const headers={'cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'};
 try {
  if(request.method!=='GET'||!['/api/isolated-preview/document','/api/isolated-preview/clear'].includes(url.pathname))return new Response('Not found',{status:404,headers});
  const claims=verifyPreviewLaunch(previewSigningSecret(env),url.searchParams.get('ticket')??'',url.origin);
  if(previewOrigin(base,claims)!==url.origin)throw new ScopeError(404,'NOT_FOUND','Not found');
  await assertProjectScope(env.DB,claims);
  const bytes=await readBuildOutput(env.DB,claims,claims.outputId);
  const clear=url.pathname.endsWith('/clear');
  const manifest=await readOutputManifest(env.DB,claims,claims.outputId);
  let seed:Record<string,string>={};
  if(claims.seedRef&&!clear) {
   const bytes=await createD1ContentStore(env.DB).get(claims.seedRef);
   if(!bytes)throw new ScopeError(503,'PREVIEW_STORAGE_UNAVAILABLE','The previous preview data could not be prepared. Try again.');
   seed=previewSeed(JSON.parse(new TextDecoder().decode(bytes)))??{};
  }
  let html=previewDocument(new TextDecoder().decode(bytes),claims.nonce,seed,manifest?.hasServer===true,'web',true,claims.seedRef);
  if(clear) {
   const target=new URL(url);target.pathname='/api/isolated-preview/document';
   // Serve the cleared document directly: no cross-origin redirect race.
   // Replace its URL before app scripts run so a later Reload does not reset.
   html=html.replace('<head>','<head><script>history.replaceState(null,"",'+JSON.stringify(target.pathname+target.search)+')</script>');
  }
  return new Response(html,{headers:{...headers,'content-type':'text/html; charset=utf-8',
   ...(clear?{'clear-site-data':'"storage"'}:{}),
   'content-security-policy':`frame-ancestors ${claims.parentOrigin}; sandbox allow-scripts allow-forms allow-same-origin`,
   'permissions-policy':'camera=(), microphone=(), geolocation=(self)'}});
 }catch(error){return new Response(error instanceof ScopeError?error.message:'The preview could not be opened.',{status:error instanceof ScopeError?error.status:500,headers});}
}
