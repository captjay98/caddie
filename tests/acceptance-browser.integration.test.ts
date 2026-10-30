import {httpCandidateRuntime} from '../scripts/acceptance-browser.ts';
import {openBrowserCheckService} from '../scripts/serve-design-capture.ts';
import {acceptanceNotesApp} from './fixtures/acceptance-notes-app.ts';
import {beforeAll,afterAll,test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createTableSql} from './fixtures/migrations.ts';
import {openAcceptanceBrowser,type CandidateRuntime} from '../scripts/acceptance-browser.ts';
import {openLocalVisualFidelity} from '../scripts/local-visual-fidelity.ts';
import {notesAppHtml} from './fixtures/brief-run-notes-app.ts';
import {freePort} from './fixtures/controls-harness.ts';
import {AUTH_FILES} from '../stacks/react-hono/auth-files.ts';
import {SERVER_FILES} from '../stacks/react-hono/server-files.ts';
import type {AcceptanceStep} from '@caddie/contracts';
const root=join(import.meta.dir,'..'),appDir=join(root,'apps/app');
let port:number,base:string,dir:string,processHandle:ReturnType<typeof Bun.spawn>,source:string;
let runner:Awaited<ReturnType<typeof openAcceptanceBrowser>>;
const identity={projectId:'p',runId:'r',admissionId:'a',planId:'plan',designId:'design',featureId:'notes',checkedImage:'image'};
beforeAll(async()=>{
 dir=mkdtempSync(join(tmpdir(),'caddie-acceptance-browser-'));port=await freePort();base=`http://127.0.0.1:${port}`;
 for(const [path,text] of Object.entries({...AUTH_FILES,...SERVER_FILES}))if(path.startsWith('caddie/')&&path.endsWith('.ts')){mkdirSync(dirname(join(dir,path)),{recursive:true});writeFileSync(join(dir,path),text);}
 writeFileSync(join(dir,'server.ts'),`import {Hono} from 'hono';import {mountSignIn,requireUser} from './caddie/auth';const app=new Hono().basePath('/api');mountSignIn(app);
 const MODE='correct';let memory=[];
 app.get('/notes',async c=>{const user=await requireUser(c);return c.json({notes:MODE==='lost'?memory:(await c.env.DB.prepare(MODE==='leaky'?'select body from notes':'select body from notes where owner=?').bind(...(MODE==='leaky'?[]:[user.id])).all()).results});});
 app.post('/notes',async c=>{const user=await requireUser(c);const {body}=await c.req.json();if(MODE==='lost')memory.push({body});else await c.env.DB.prepare('insert into notes(owner,body) values(?,?)').bind(user.id,body).run();return c.json({ok:true});});
 app.get('/outbound',async()=>{try{await fetch('https://example.com');return new Response('escaped');}catch{return new Response('blocked');}});export default app;`);
 const built=await Bun.build({entrypoints:[join(dir,'server.ts')],target:'browser',format:'esm',conditions:['workerd','worker','browser'],external:['node:*','cloudflare:*'],minify:false,plugins:[{name:'deps',setup(b){b.onResolve({filter:/^(hono|better-auth)(\/.*)?$/},args=>({path:Bun.resolveSync(args.path,appDir)}));}}]});
 if(!built.success)throw new Error(built.logs.map(String).join('\n'));source=await built.outputs[0]!.text();
 const config=join(dir,'acceptance-runtime.wrangler.json');writeFileSync(config,JSON.stringify({name:'acceptance-runtime-fixture',main:join(import.meta.dir,'fixtures/acceptance-runtime-worker.ts'),compatibility_date:'2026-06-01',compatibility_flags:['nodejs_compat'],worker_loaders:[{binding:'LOADER'}],d1_databases:[{binding:'DB',database_name:'acceptance-fixture',database_id:'00000000-0000-0000-0000-000000000001'}],durable_objects:{bindings:[{name:'PREVIEW_DB',class_name:'PreviewDatabase'}]},migrations:[{tag:'v1',new_sqlite_classes:['PreviewDatabase']}]}));
 const cli=Bun.resolveSync('wrangler',appDir).replace(/wrangler-dist\/[^/]+\.js$/,'wrangler-dist/cli.js');const log=Bun.file(join(dir,'worker.log'));
 processHandle=Bun.spawn(['node',cli,'dev','--config',config,'--port',String(port),'--ip','127.0.0.1','--persist-to',join(dir,'state')],{cwd:root,stdout:log,stderr:log,env:{...process.env,WRANGLER_SEND_METRICS:'false',CI:'true'}});
 const until=Date.now()+90000;for(;;){try{if((await fetch(base+'/health')).ok)break;}catch{}if(Date.now()>until)throw new Error(await log.text());await Bun.sleep(200);}
 runner=await openAcceptanceBrowser(join(dir,'evidence'));
},120000);
afterAll(async()=>{await runner?.close();processHandle?.kill();if(port)Bun.spawnSync(['pkill','-f',`acceptance-runtime.wrangler.json --port ${port} `]);});
test('native preview smoke proves IndexedDB survives reload and rejects caught startup errors',async()=>{
 expect((await runner.smoke(runtime('correct','<main>Records are ready<button>New record</button></main>'))).passed).toBe(true);
 expect((await runner.smoke(runtime('correct',`<main>Couldn't open your records</main>`))).passed).toBe(false);
 expect((await runner.smoke(runtime('correct',`<main>Opening records</main><script>throw new Error('Storage startup failed')</script>`))).passed).toBe(false);
 expect((await runner.smoke(runtime('correct',''))).passed).toBe(false);
 expect((await runner.smoke(runtime('correct','<main>Loading your records…</main>'))).passed).toBe(false);
 expect((await runner.smoke(runtime('correct',`<main>Records<button>New record</button></main><script>setTimeout(()=>{throw new Error('Delayed startup failure')},600)</script>`))).passed).toBe(false);
	// Six probes: five intentionally never reach a usable screen, and the
	// startup check observes each for up to 6s before failing it.
},60000);
function runtime(mode='correct',document=notesAppHtml()):CandidateRuntime {
 let epoch=0;const prefix=crypto.randomUUID();
 // The actual server differs only by its deliberate defect. No mock success
 // receipts, app responses or auth sessions are injected by the browser.
 const code=source.replace('MODE = "correct"',`MODE = "${mode}"`);
 if(mode!=='correct'&&code===source)throw new Error('The deliberate defect was not applied');
 return {document:document.replaceAll('/api/auth/session','/api/auth/me'),async call(session,action,request){if(action==='restart'){epoch++;return {restarted:true};}const res=await fetch(base,{method:'POST',body:JSON.stringify({session:prefix+session,action,request,source:code,epoch})});if(!res.ok)throw new Error(await res.text());return res.json();}};
}
const save:AcceptanceStep[]=[{kind:'actor',user:'a'},{kind:'open',path:'/notes'},{kind:'fill',label:'Note',value:'{{marker}}'},{kind:'click',name:'Save note'},{kind:'expect',text:'{{marker}}',visible:true}];
async function check(rt:CandidateRuntime,steps:AcceptanceStep[]){return runner.check({identity,criteria:[{featureId:'notes',text:'Save safely'}],journeys:{version:1,criteria:[{featureId:'notes',text:'Save safely',steps}],states:[{title:'Notes',steps:[{kind:'open',path:'/notes'}]}]},runtime:rt,operationKey:crypto.randomUUID()});}
test('real browser + Worker Loader: saving survives a fresh server isolate and cleared browser cache',async()=>{
 const result=await check(runtime(),[...save,{kind:'restart'},{kind:'expect',text:'{{marker}}',visible:true}]);expect(result.checks[0]!.passed).toBe(true);
},45000);
test('fake saving, lost restart data, cross-user leakage and missing behavior each fail',async()=>{
 expect((await check(runtime('correct',notesAppHtml({neverSaves:true})),save)).checks[0]!.passed).toBe(false);
 expect((await check(runtime('lost'),[...save,{kind:'restart'},{kind:'expect',text:'{{marker}}',visible:true}])).checks[0]!.passed).toBe(false);
 const isolation:AcceptanceStep[]=[...save,{kind:'actor',user:'b'},{kind:'open',path:'/notes'},{kind:'expect',text:'Your notes',visible:true},{kind:'expect',text:'{{marker}}',visible:false}];
 expect((await check(runtime(),isolation)).checks[0]!.passed).toBe(true);
 expect((await check(runtime('leaky'),isolation)).checks[0]!.passed).toBe(false);
 expect((await check(runtime(),[{kind:'actor',user:'a'},{kind:'open',path:'/notes'},{kind:'expect',text:'Promised export',visible:true}])).checks[0]!.passed).toBe(false);
},90000);
// 2026-10-30 EggOps: the journey was "open / → press Start my farm → sign in as
// A", but A was signed in on a fresh first screen with no sign-in, so every
// check timed out on the Email field. A now taps the stranger's path first.
function frontDoorApp(withStart:boolean):string {
 const signedOut="if (!signedIn) { renderEmailStep(); return; }";const html=notesAppHtml();if(!html.includes(signedOut))throw new Error('fixture changed');
 return html.replace(signedOut,`if (!signedIn) { if ((location.hash || '#/') === '#/start') { renderEmailStep(); return; } h('<section><h1>Front door</h1>${withStart?'<a href="#/start">Start</a>':''}</section>'); return; }`);
}
test('a person signs in where the journey has got to, and a screen with no sign-in says so plainly',async()=>{
 const path:AcceptanceStep[]=[{kind:'open',path:'/'},{kind:'click',name:'Start'}];
 const after:AcceptanceStep[]=[{kind:'open',path:'/notes'},{kind:'fill',label:'Note',value:'{{marker}}'},{kind:'click',name:'Save note'},{kind:'expect',text:'{{marker}}',visible:true}];
 expect((await check(runtime('correct',frontDoorApp(true)),[...path,{kind:'actor',user:'a'},...after])).checks[0]!.passed).toBe(true);
 const stuck=await check(runtime('correct',frontDoorApp(false)),[{kind:'open',path:'/'},{kind:'actor',user:'a'},...after]);
 expect(stuck.checks[0]!.passed).toBe(false);
 expect(stuck.checks[0]!.reason).toBe('Person A could not sign in: there was no field labelled "Email" (Caddie\'s sign-in) on the app\'s first screen or after opening "/".');
},60000);
test('state capture navigates to distinct screens; missing navigation fails and overflow is detected',async()=>{
 const rt=runtime();const viewport={name:'phone' as const,width:390 as const,height:844 as const};
 const home=await runner.captureState({runtime:rt,title:'Home',steps:[{kind:'actor',user:'a'},{kind:'expect',text:'Welcome',visible:true}],viewport});
 const notes=await runner.captureState({runtime:rt,title:'Notes',steps:[{kind:'actor',user:'a'},{kind:'open',path:'/notes'},{kind:'expect',text:'Your notes',visible:true}],viewport});
 expect(home.capture.sha256).not.toBe(notes.capture.sha256);
 const overflow=await runner.captureState({runtime:runtime('correct',notesAppHtml().replace('<body>','<body style="min-width:900px">')),title:'Overflow',steps:[{kind:'expect',text:'Sign in',visible:true}],viewport});expect(overflow.overflow).toBe(true);
 const pixel=await openLocalVisualFidelity({directory:join(dir,'pixels')});try{await pixel.adoptCapture(home);await pixel.adoptCapture(overflow);const compared=await pixel.port.compare({approved:home.capture,built:overflow.capture,viewport,identity:{projectId:'p',planRevisionId:'plan',designRevisionId:'design',designHash:'a'.repeat(64),buildImage:'image',builtDocumentHash:home.capture.documentHash},operationKey:'overflow'});expect(compared.differences.some(d=>d.area==='overflow')).toBe(true);}finally{await pixel.close();}
},45000);

test('offline reconnect persists real queued data; dropping the queue fails despite unrelated passing tests',async()=>{
 const steps:AcceptanceStep[]=[...save.slice(0,3),{kind:'offline',value:true},{kind:'click',name:'Save note'},{kind:'expect',text:'Queued',visible:true},{kind:'offline',value:false},{kind:'expect',text:'{{marker}}',visible:true},{kind:'restart'},{kind:'expect',text:'{{marker}}',visible:true}];
 expect((await check(runtime('correct',acceptanceNotesApp()),steps)).checks[0]!.passed).toBe(true);
 expect((await check(runtime('correct',acceptanceNotesApp(true)+'<!-- 100 unrelated tests pass -->'),steps)).checks[0]!.passed).toBe(false);
},45000);
test('actual loading, error and recovery states can be navigated on phone and desktop',async()=>{
 for(const viewport of [{name:'phone' as const,width:390 as const,height:844 as const},{name:'desktop' as const,width:1440 as const,height:900 as const}]) {
  const rt=runtime('correct',acceptanceNotesApp());
  const result=await runner.captureState({runtime:rt,title:'Recovery',viewport,steps:[{kind:'actor',user:'a'},{kind:'fault',path:'/api/notes',mode:'fail'},{kind:'open',path:'/notes'},{kind:'expect',text:'Could not load notes',visible:true},{kind:'fault',path:'/api/notes',mode:'clear'},{kind:'click',name:'Try again'},{kind:'expect',text:'Your notes',visible:true}]});
  expect(result.capture.width).toBe(viewport.width);
  const loading=await runner.captureState({runtime:runtime('correct',acceptanceNotesApp()),title:'Loading',viewport,steps:[{kind:'actor',user:'a'},{kind:'fault',path:'/api/notes',mode:'hold'},{kind:'open',path:'/notes'},{kind:'expect',text:'Loading notes',visible:true}]});
  expect(loading.capture.sha256).not.toBe(result.capture.sha256);
 }
},45000);

test('private service drives the production unpublished runtime; Stop revokes the capability immediately',async()=>{
 const statements=["create table projects(id text primary key,workspaceId text)","insert into projects values('p','w')","create table workspace_memberships(id text,userId text,workspaceId text)","insert into workspace_memberships values('m','u','w')","create table build_workflows(projectId text,runId text,phase text,planId text,spendPayerId text,approvedDesignRevisionId text)","insert into build_workflows values('p','r','building','plan','a','design')","create table plan_doc_revisions(id text,bodyHash text)","insert into plan_doc_revisions values('design','hash')","create table approvals(projectId text,resourceId text,action text,policyVersion text,status text,revisionHash text,decidedBy text,expiresAt text)","insert into approvals values('p','design','design','v1','approved','hash','u','2099-01-01T00:00:00.000Z')","create table large_content(sha256 text primary key,bytes integer,chunks integer,createdAt text)","create table large_content_chunks(sha256 text,idx integer,bytes blob,primary key(sha256,idx))",createTableSql('acceptance_candidates')];
 const initialized=await fetch(base+'/__test/init',{method:'POST',body:JSON.stringify({statements})});expect(initialized.ok).toBe(true);
 const response=await fetch(base+'/__test/candidate',{method:'POST',body:JSON.stringify({identity,bundle:{document:notesAppHtml().replaceAll('/api/auth/session','/api/auth/me'),server:source,migrations:[{name:'0000_auth.sql',sql:AUTH_FILES['migrations/0000_caddie_auth.sql']},{name:'0001_notes.sql',sql:'create table notes(owner text,body text);'}]}})});
 expect(response.ok).toBe(true);const candidate=await response.json() as any;
 const token='private-test-browser-service-token-123456';const service=await openBrowserCheckService({token,directory:join(dir,'service-evidence'),allowedOrigins:[base]});
 try {
  expect((await service.fetch(new Request('http://private/check',{method:'POST'}))).status).toBe(401);
  const criteria=[{featureId:'notes',text:'Save safely'}];
  const output=await service.fetch(new Request('http://private/check',{method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify({identity,criteria,operationKey:'private-real',runtime:candidate,journeys:{version:1,criteria:[{...criteria[0],steps:[...save,{kind:'restart'},{kind:'expect',text:'{{marker}}',visible:true}]}],states:[{title:'Notes',steps:save}]}})}));
  expect(output.ok).toBe(true);expect((await output.json() as any).checks[0].passed).toBe(true);
  const runtime=httpCandidateRuntime(candidate,[base]);await fetch(base+'/__test/stop',{method:'POST'});await expect(runtime.call('after-stop','inbox')).rejects.toThrow('404');
  expect(()=>httpCandidateRuntime({...candidate,url:'http://169.254.169.254/api/acceptance-runtime'},[base])).toThrow('Unapproved');
 }finally{await service.close();}
},45000);
