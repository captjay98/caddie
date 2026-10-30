import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {sqliteD1} from './fixtures/sqlite-d1.ts';
import {previewOrigin,signPreviewLaunch,verifyPreviewLaunch,previewBase,isolatedPreviewRequest,previewSigningSecret} from '../apps/app/src/server/isolated-preview.ts';
const base='http://preview.localhost:5176';
const secret='a dedicated local test secret long enough';
const scope={actorId:'actor-1',workspaceId:'workspace-1',projectId:'project-1'};
test('native storage origins are stable per actor/project, never Caddie origin',()=>{
 expect(previewOrigin(base,scope)).toBe(previewOrigin(base,scope));
 expect(previewOrigin(base,scope)).not.toBe(previewOrigin(base,{...scope,actorId:'actor-2'}));
 expect(previewOrigin(base,scope)).not.toBe(previewOrigin(base,{...scope,projectId:'project-2'}));
 expect(previewBase(undefined,'http://localhost:5176')).toBe(base);
 expect(()=>previewBase(undefined,'https://caddie.example')).toThrow();
 expect(()=>previewBase('https://caddie.example','https://caddie.example')).toThrow();
 expect(()=>previewBase('https://example.com','https://app.example.com')).toThrow();
});
test('native documents recheck membership and exact output scope; reset targets only their origin',async()=>{
 const sqlite=new Database(':memory:');
 sqlite.exec(`create table projects(id text,workspaceId text);insert into projects values('project-1','workspace-1');
 create table workspace_memberships(id text,userId text,workspaceId text);insert into workspace_memberships values('m','actor-1','workspace-1');
 create table workflow_outputs(id text,projectId text,sha256 text,manifestSha256 text);
 insert into workflow_outputs values('out-1','project-1','body',null);insert into workflow_outputs values('other','project-2','body',null);
 create table artifact_content(contentHash text,bytes blob,size integer,createdAt text);`);
 sqlite.prepare('insert into artifact_content values(?,?,?,?)').run('body',new TextEncoder().encode('<main>Records</main>'),20,'now');
 const env={DB:sqliteD1(sqlite),BETTER_AUTH_URL:'http://localhost:5176',BETTER_AUTH_SECRET:secret,PREVIEW_SIGNING_SECRET:secret};
 const origin=previewOrigin(base,scope);
 const claims={...scope,origin,parentOrigin:'http://localhost:5176',outputId:'out-1',nonce:'nonce-12345678',expiresAt:Date.now()+60000};
 const request=(path='document',input=claims)=>new Request(origin+'/api/isolated-preview/'+path+'?ticket='+signPreviewLaunch(secret,input));
 try {
  const document=await isolatedPreviewRequest(request(),env);
  expect(document?.status).toBe(200);expect(await document!.text()).toContain('<main>Records</main>');
  expect(document?.headers.get('content-security-policy')).toContain('frame-ancestors http://localhost:5176');
  expect((await isolatedPreviewRequest(request('document',{...claims,outputId:'other'}),env))?.status).toBe(404);
  const reset=await isolatedPreviewRequest(request('clear'),env);
  expect(reset?.status).toBe(200);expect(reset?.headers.get('clear-site-data')).toBe('"storage"');
  expect(await reset!.text()).toContain('history.replaceState');
  sqlite.exec('delete from workspace_memberships');
  expect((await isolatedPreviewRequest(request(),env))?.status).toBe(403);
 }finally{sqlite.close();}
});
test('preview hosts refuse Caddie APIs/assets even with invalid config or expired links',async()=>{
 const env={DB:{} as any,BETTER_AUTH_URL:'http://localhost:5176',BETTER_AUTH_SECRET:secret};
 const origin=previewOrigin(base,scope);
 for(const path of ['/api/auth/get-session','/app/','/agents/coordinator/test','/api/isolated-preview/document'])
  expect((await isolatedPreviewRequest(new Request(origin+path),env))?.status).toBe(404);
 expect((await isolatedPreviewRequest(new Request(origin+'/api/auth/get-session'),{...env,PREVIEW_BASE_URL:'http://localhost:5176'}))?.status).toBe(404);
 expect(await isolatedPreviewRequest(new Request('http://localhost:5176/api/auth/get-session'),env)).toBeNull();
 expect(await isolatedPreviewRequest(new Request('https://app.example.com/api/auth/get-session'),{...env,BETTER_AUTH_URL:'https://app.example.com',PREVIEW_BASE_URL:'https://example.com'})).toBeNull();
});
test('hosted preview worker needs a dedicated key, not the Caddie session secret',()=>{
 expect(()=>previewSigningSecret({BETTER_AUTH_URL:'https://app.example.com',BETTER_AUTH_SECRET:secret})).toThrow();
 expect(previewSigningSecret({BETTER_AUTH_URL:'https://app.example.com',PREVIEW_SIGNING_SECRET:secret})).toBe(secret);
 expect(previewSigningSecret({BETTER_AUTH_URL:'http://localhost:5176',BETTER_AUTH_SECRET:secret})).not.toBe(secret);
});
test('signed launches expire and cannot be replayed on another preview host',()=>{
 const origin=previewOrigin(base,scope);
 const claims={...scope,origin,parentOrigin:'http://localhost:5176',outputId:'out-1',nonce:'nonce-12345678',expiresAt:2000};
 const token=signPreviewLaunch(secret,claims);
 expect(verifyPreviewLaunch(secret,token,origin,1000)).toEqual(claims);
 expect(()=>verifyPreviewLaunch(secret,token,origin,2001)).toThrow();
 expect(()=>verifyPreviewLaunch(secret,token+'x',origin,1000)).toThrow();
 expect(()=>verifyPreviewLaunch(secret,token,'http://p-another.preview.localhost:5176',1000)).toThrow();
});
