/** Real browser executor for the approved declarative journeys. Generated code
 * runs only in an opaque preview iframe; its backend runs in Worker Loader.
 * The host process never imports or evaluates generated server code. */
import {chromium,type Browser,type BrowserContext,type Frame,type Page,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {AcceptanceJourneysSchema,type AcceptanceJourneys,type AcceptanceStep} from '@caddie/contracts';
import * as v from 'valibot';
import {previewDocument,FETCH_KIND,FETCH_RESULT_KIND,BRIDGE_KIND} from '../apps/app/src/shared/preview-frame.ts';
import {updateCookieJar,cookieHeader} from '../apps/app/src/shared/preview-cookies.ts';
import {criterionHash,type AcceptanceIdentity,type AcceptanceCriterion,type IndependentAcceptanceResult} from '../apps/app/src/server/independent-acceptance.ts';
import type {RuntimeCandidate} from '../apps/app/src/server/acceptance-candidate.ts';
import type {BridgeRequest,BridgeResponse} from '../apps/app/src/server/preview-runtime.ts';
import type {FidelityViewport,VisualCapture} from '../apps/app/src/server/visual-fidelity.ts';
export interface CandidateRuntime {
 document:string;
 call(session:string,action:'request'|'restart'|'inbox'|'dispose',request?:BridgeRequest):Promise<any>;
}
export function httpCandidateRuntime(candidate:RuntimeCandidate,allowedOrigins:readonly string[],signal?:AbortSignal):CandidateRuntime {
 const url=new URL(candidate.url);if(!allowedOrigins.includes(url.origin)||url.pathname!=='/api/acceptance-runtime'||url.username||url.password)throw new Error('Unapproved candidate runtime origin');
 return {document:candidate.document,async call(session,action,request) {
  signal?.throwIfAborted();
  const response=await fetch(url,{method:'POST',headers:{authorization:`Bearer ${candidate.token}`,'content-type':'application/json'},body:JSON.stringify({session,action,request}),redirect:'error',signal});
  if(!response.ok)throw new Error(`Private candidate runtime refused ${action} (${response.status})`);
  return response.json();
 }};
}
interface Actor {context:BrowserContext;page:Page;frame:Frame;offline:boolean;faults:Map<string,'fail'|'hold'>;held:Set<()=>void>;storage:Record<string,string>;reads:number;writes:number;errors:string[];}
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export async function openAcceptanceBrowser(directory:string,providedBrowser?:Browser) {
 const browser=providedBrowser??await chromium.launch({headless:true});await mkdir(directory,{recursive:true});
 async function execute(runtime:CandidateRuntime,steps:readonly AcceptanceStep[],options:{session:string;viewport:FidelityViewport;signal?:AbortSignal;timeoutMs?:number;capture?:boolean;storageProbe?:boolean}) {
  const actors=new Map<string,Actor>();let active:Actor|undefined;
  const marker=`check-${randomBytes(8).toString('hex')}`;const number=String(1000+parseInt(randomBytes(2).toString('hex'),16)%8000);
  const value=(text:string)=>text.replaceAll('{{marker}}',marker).replaceAll('{{number}}',number);
  const deadline=Date.now()+(options.timeoutMs??90_000);const remaining=()=>Math.max(1,deadline-Date.now());
  const ensure=()=>{options.signal?.throwIfAborted();if(Date.now()>=deadline)throw new Error('Independent journey deadline exceeded');};
  const close=async()=>{for(const actor of actors.values()){for(const release of actor.held)release();await actor.context.close().catch(()=>{});}};
  const abort=()=>{void close();};options.signal?.addEventListener('abort',abort,{once:true});
  const open=async(name:string)=>{
   if(actors.has(name)){active=actors.get(name)!;return active;}
   ensure();const context=await browser.newContext({viewport:options.viewport,reducedMotion:'reduce'});
   const page=await context.newPage();page.setDefaultTimeout(Math.min(10_000,remaining()));
   const nonce=randomBytes(12).toString('hex');const jar=new Map<string,string>();
   const actor:Actor={context,page,frame:null as unknown as Frame,offline:false,faults:new Map(),held:new Set(),storage:{},reads:0,writes:0,errors:[]};
   actors.set(name,actor);active=actor;
   page.on('pageerror',error=>actor.errors.push(`App browser error: ${error.message.slice(0,300)}`));
   await page.exposeBinding('hostRelay',async(source,message:{request:BridgeRequest})=>{
    if(source.frame!==page.mainFrame())throw new Error('Only the preview parent may relay');ensure();
    const request=message.request;
    if(!request||!/^\/api(?:\/|\?|$)/.test(request.path))throw new Error('Invalid app relay request');
    if(actor.offline)return {error:'Network unavailable'};
    const fault=[...actor.faults].find(([path])=>request.path.startsWith(path));
    if(fault?.[1]==='hold')await new Promise<void>(resolve=>{const release=()=>{actor.held.delete(release);resolve();};actor.held.add(release);});
    ensure();
    if(fault?.[1]==='fail')return {response:{status:503,headers:[['content-type','application/json']],body:Buffer.from(JSON.stringify({error:'temporarily_unavailable'})).toString('base64')}};
    const headers=request.headers.filter(([key])=>!['cookie','authorization'].includes(key.toLowerCase()));
    const cookie=cookieHeader(jar);if(cookie)headers.push(['cookie',cookie]);
    const response=await runtime.call(options.session,'request',{...request,headers}) as BridgeResponse;
    updateCookieJar(jar,response.headers);
    if(!/^\/api\/(?:auth|health)(?:\/|\?|$)/.test(request.path)) {if(request.method==='GET')actor.reads++;else if(['POST','PUT','PATCH','DELETE'].includes(request.method))actor.writes++;}
    return {response};
   });
   await page.exposeBinding('hostStorage',(source,data:Record<string,string>)=>{if(source.frame===page.mainFrame()&&data&&typeof data==='object'&&JSON.stringify(data).length<=100_000&&Object.entries(data).every(([k,v])=>k!=='__proto__'&&typeof v==='string'))actor.storage={...data};});
   await page.route('**/*',async route=>{
    const url=new URL(route.request().url());if(!['https://candidate.invalid','https://app-preview.invalid'].includes(url.origin))return route.abort();
    if(url.origin==='https://app-preview.invalid'&&url.pathname==='/frame')return route.fulfill({contentType:'text/html',body:previewDocument(runtime.document,nonce,{},true,'web',true)});
    if(url.origin!=='https://candidate.invalid')return route.abort();
    if(url.pathname!=='/')return route.abort();
    const html=`<!doctype html><html><head><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block;overflow:hidden}</style></head><body><iframe sandbox="allow-scripts allow-forms allow-same-origin" src="https://app-preview.invalid/frame"></iframe><script>
     const nonce=${JSON.stringify(nonce)};window.addEventListener('message',async event=>{const frame=document.querySelector('iframe');const m=event.data;if(event.origin!=='https://app-preview.invalid'||event.source!==frame.contentWindow||!m||m.nonce!==nonce)return;
      if(m.kind===${JSON.stringify(BRIDGE_KIND)}){await window.hostStorage(m.storage);return;}
      if(m.kind!==${JSON.stringify(FETCH_KIND)})return;let result;try{result=await window.hostRelay({request:m.request});}catch{result={error:'The isolated app request failed'};}
      frame.contentWindow.postMessage({kind:${JSON.stringify(FETCH_RESULT_KIND)},nonce,id:m.id,...result},'https://app-preview.invalid');});</script></body></html>`;
    return route.fulfill({contentType:'text/html',body:html});
   });
   await page.goto('https://candidate.invalid/',{waitUntil:'load',timeout:remaining()});
   actor.frame=page.frames().find(frame=>frame.url()==='https://app-preview.invalid/frame')!;if(!actor.frame)throw new Error('The isolated app did not load');
   return actor;
  };
  const replay=async(actor:Actor,step:AcceptanceStep)=>{
   if(step.kind==='open')await actor.frame.evaluate(path=>{location.hash=path;},step.path);
   else if(step.kind==='click'){const button=actor.frame.getByRole('button',{name:step.name,exact:true});await button.or(actor.frame.getByRole('link',{name:step.name,exact:true})).first().click();}
  };
  // A person signs in where the journey has got to: "open / → press Start my
  // farm → sign in as A" means A taps through the same screens first (the
  // 2026-10-30 EggOps welcome screen had no sign-in; it was one tap further).
  // Only screen opens and taps a stranger made are repeated. When that path
  // shows no sign-in, A falls back to the app's first screen, as before.
  const signIn=async(user:'a'|'b',path:readonly AcceptanceStep[])=>{
   let actor=await open(user);const email=`${user}@acceptance.test`;
   const field=()=>actor.frame.getByLabel('Email',{exact:true});
   if(path.length) {
    let shown=false;
    try{for(const step of path)await replay(actor,step);await field().waitFor({state:'visible',timeout:Math.min(5_000,remaining())});shown=true;}catch{ensure();}
    if(!shown){await actor.context.close().catch(()=>{});actors.delete(user);actor=await open(user);}
   }
   const route=path.length?`the app's first screen or after ${path.map(step=>step.kind==='open'?`opening "${step.path}"`:`pressing "${(step as {name:string}).name}"`).join(', ')}`:'the app\'s first screen';
   try{await field().waitFor({state:'visible',timeout:Math.min(10_000,remaining())});}
   catch{ensure();throw new Error(`Person ${user.toUpperCase()} could not sign in: there was no field labelled "Email" (Caddie's sign-in) on ${route}.`);}
   await field().fill(email);await actor.frame.getByRole('button',{name:'Email me a code',exact:true}).click();
   await actor.frame.getByLabel('Code',{exact:true}).waitFor({state:'visible',timeout:Math.min(10_000,remaining())});
   const inbox=await runtime.call(options.session,'inbox');const code=inbox.codes?.find((row:any)=>row.email===email)?.code;
   if(!code)throw new Error('The real app sign-in code did not reach its isolated inbox');
   await actor.frame.getByLabel('Code',{exact:true}).fill(String(code));await actor.frame.getByRole('button',{name:'Sign in',exact:true}).click();
   await actor.frame.getByLabel('Code',{exact:true}).waitFor({state:'hidden',timeout:Math.min(10_000,remaining())});
  };
  let restartRead:{actor:Actor;reads:number}|undefined;
  try {
   if(options.storageProbe) {
    const actor=await open('public');
    await actor.frame.evaluate(async()=>{
     await new Promise<void>((resolve,reject)=>{
      const request=indexedDB.open('__caddie_storage_probe',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('records');
      request.onerror=()=>reject(request.error);
      request.onsuccess=()=>{const db=request.result;const tx=db.transaction('records','readwrite');tx.objectStore('records').put('saved','record');tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>{db.close();reject(tx.error)}};
     });
    });
    const reload=actor.page.waitForEvent('framenavigated',{predicate:f=>f===actor.frame,timeout:remaining()});
    await actor.frame.evaluate(()=>location.reload());await reload;
    await actor.frame.waitForLoadState('load',{timeout:remaining()});
    await actor.frame.evaluate(async()=>{
     await new Promise<void>((resolve,reject)=>{const request=indexedDB.open('__caddie_storage_probe',1);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result;const read=db.transaction('records').objectStore('records').get('record');read.onsuccess=()=>{db.close();read.result==='saved'?resolve():reject(new Error('Preview records did not survive reload'))};read.onerror=()=>{db.close();reject(read.error)}}});
    });
    // A storage probe alone cannot make an empty or permanently loading app
    // ready. Require a visible usable initial surface and observe it through
    // async startup. Approved behavioral journeys remain the deeper gate.
    const startupDeadline=Math.min(deadline,Date.now()+6000);let usableSince=0;let ready=false;
    while(Date.now()<startupDeadline) {
     ensure();if(actor.errors.length)throw new Error(actor.errors[0]);
     const state=await actor.frame.evaluate(()=>{
      const text=document.body.innerText.trim();
      const visible=(el:Element)=>el.getClientRects().length>0;
      const controls=[...document.querySelectorAll('button,a[href],input,select,textarea,[role="button"]')].some(el=>visible(el)&&!el.hasAttribute('disabled'));
      const content=text.length>=30&&[...document.querySelectorAll('h1,h2,article')].some(visible);
      const busy=[...document.querySelectorAll('[aria-busy="true"],[role="progressbar"],.skeleton,.spinner')].some(visible)||/^(loading|opening|please wait)(?:[\s.…!]|$)/i.test(text);
      const fatal=/couldn.t open your records|couldn.t load your records|application error|something went wrong loading/i.test(text);
      return {ready:!!text&&(controls||content)&&!busy,fatal};
     });
     if(state.fatal)throw new Error('The app displayed a records/startup error in its real preview');
     if(state.ready){usableSince||=Date.now();if(Date.now()-usableSince>=1000){ready=true;break;}}
     else usableSince=0;
     await actor.page.waitForTimeout(100);
    }
    if(!ready)throw new Error('The app did not finish opening a usable initial screen in its preview');
   }
   const strangerPath:AcceptanceStep[]=[];
   for(const step of steps) {
    ensure();if(step.kind==='actor'){if(!actors.has(step.user))await signIn(step.user,strangerPath);else active=actors.get(step.user)!;continue;}
    const actor=active??await open('public');
    if(actor===actors.get('public')&&(step.kind==='open'||step.kind==='click'))strangerPath.push(step);
    switch(step.kind) {
     case 'open':await actor.frame.evaluate(path=>{location.hash=path;},step.path);break;
     case 'fill':await actor.frame.getByLabel(step.label,{exact:true}).fill(value(step.value));break;
     case 'click':{const button=actor.frame.getByRole('button',{name:step.name,exact:true});await button.or(actor.frame.getByRole('link',{name:step.name,exact:true})).first().click();break;}
     case 'expect':await expect(actor.frame.getByText(value(step.text),{exact:false}).first())[step.visible?'toBeVisible':'toBeHidden']({timeout:Math.min(10_000,remaining())});break;
     case 'offline':actor.offline=step.value;await actor.context.setOffline(step.value);break;
     case 'fault':if(step.mode==='clear'){actor.faults.delete(step.path);for(const release of actor.held)release();}else actor.faults.set(step.path,step.mode);break;
     case 'restart':await runtime.call(options.session,'restart');restartRead={actor,reads:actor.reads};actor.storage={};{const navigated=actor.page.waitForEvent('framenavigated',{predicate:frame=>frame===actor.frame,timeout:remaining()});await actor.frame.evaluate(()=>{localStorage.clear();location.reload();});await navigated;await actor.frame.waitForLoadState('load',{timeout:remaining()});}break;
     case 'reload':{const navigated=actor.page.waitForEvent('framenavigated',{predicate:frame=>frame===actor.frame,timeout:remaining()});await actor.frame.evaluate(()=>location.reload());await navigated;await actor.frame.waitForLoadState('load',{timeout:remaining()});}break;
    }
   }
   ensure();if(restartRead && (restartRead.actor.reads<=restartRead.reads || restartRead.actor.writes===0))throw new Error('Restart acceptance requires a real app write and a fresh data read after restart');
   const actor=active!;if(actor.errors.length)throw new Error(actor.errors[0]);
   let captured: {capture:VisualCapture;bytes:Buffer;overflow:boolean;errors:string[]}|undefined;
   if(options.capture) {
    const overflow=await actor.frame.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth+1);
    const bytes=await actor.page.screenshot({type:'png',animations:'disabled',timeout:remaining()});const pngHash=sha(bytes);const artifact=join(directory,`${pngHash}.png`);await writeFile(artifact,bytes);
    captured={capture:{artifact,sha256:pngHash,documentHash:sha(runtime.document),width:options.viewport.width,height:options.viewport.height,capturedAt:new Date().toISOString()},bytes,overflow,errors:actor.errors};
   }
   return {marker,captured};
  }finally{options.signal?.removeEventListener('abort',abort);await close();await runtime.call(options.session,'dispose').catch(()=>{});}
 }
 return {
  async smoke(runtime:CandidateRuntime,signal?:AbortSignal) {
   try {await execute(runtime,[],{session:'preview-smoke',viewport:{name:'phone',width:390,height:844},signal,storageProbe:true});return {passed:true,errors:[] as string[]};}
   catch(error){return {passed:false,errors:[error instanceof Error?error.message.slice(0,1000):'The preview check failed']};}
  },
  async check(input:{identity:AcceptanceIdentity;criteria:readonly AcceptanceCriterion[];journeys:AcceptanceJourneys;runtime:CandidateRuntime;signal?:AbortSignal;operationKey:string}):Promise<IndependentAcceptanceResult> {
   const parsed=v.safeParse(AcceptanceJourneysSchema,input.journeys);if(!parsed.success)throw new Error('Invalid approved journey manifest');
   const checks=[];const bounded=AbortSignal.any([...(input.signal?[input.signal]:[]),AbortSignal.timeout(110_000)]);
   for(const criterion of input.criteria) {
    const mapping=parsed.output.criteria.find(item=>item.featureId===criterion.featureId&&item.text===criterion.text);if(!mapping)throw new Error('Missing approved criterion mapping');
    let passed=false;let reason='';
    try{await execute(input.runtime,mapping.steps,{session:`criterion:${criterionHash(criterion)}`,viewport:{name:'phone',width:390,height:844},signal:bounded});passed=true;}
    catch(error){bounded.throwIfAborted();reason=error instanceof Error?error.message.slice(0,1000):'App check failed';}
    const evidence={identity:input.identity,criterion,steps:mapping.steps,passed,reason};const evidenceId=sha(JSON.stringify(evidence));await writeFile(join(directory,`${evidenceId}.json`),JSON.stringify(evidence,null,2));
    // The reason travels back so the repair is told what broke, not left to guess.
    checks.push({criterionHash:criterionHash(criterion),passed,evidenceId,...(passed?{}:{reason:reason.slice(0,600)})});
   }
   return {identity:input.identity,checks};
  },
  async captureState(input:{title:string;steps:readonly AcceptanceStep[];runtime:CandidateRuntime;viewport:FidelityViewport;signal?:AbortSignal}) {
   const result=await execute(input.runtime,input.steps,{session:`state:${sha(input.title)}:${input.viewport.name}`,viewport:input.viewport,signal:input.signal,capture:true});return result.captured!;
  },
  close:async()=>{if(!providedBrowser)await browser.close();},
 };
}
