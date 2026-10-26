/** Private local browser service. Credentials live in an ignored config file. */
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {openLocalDesignReviewCapture} from './local-design-review-capture.ts';
import {openLocalVisualFidelity} from './local-visual-fidelity.ts';
import {openAcceptanceBrowser,httpCandidateRuntime} from './acceptance-browser.ts';
export async function openBrowserCheckService(config:{token:string;directory:string;allowedOrigins:readonly string[]}) {
 if(config.token.length<32||!config.allowedOrigins.length)throw new Error('Invalid private browser configuration');
 const browser=await chromium.launch({headless:true});
 const draft=await openLocalDesignReviewCapture(resolve(config.directory),browser);
 const fidelity=await openLocalVisualFidelity({directory:resolve(config.directory),browser});
 const acceptance=await openAcceptanceBrowser(resolve(config.directory),browser);
 // Serialize expensive jobs. No job may keep another request alive past its
 // deadline; cancellation closes its contexts, not the shared browser.
 let tail=Promise.resolve();
 const fetchRequest=async(request:Request):Promise<Response>=>{
  if(request.headers.get('authorization')!==`Bearer ${config.token}`)return new Response('Unauthorized',{status:401});
  if(request.method!=='POST')return new Response('Not found',{status:404});
  const path=new URL(request.url).pathname;
  if(!['/capture','/check','/acceptance','/state-capture','/fidelity-capture','/compare'].includes(path))return new Response('Not found',{status:404});
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(new Error('Browser check deadline exceeded')),115_000);
  const abort=()=>controller.abort(request.signal.reason);request.signal.addEventListener('abort',abort,{once:true});
  try {
   if(Number(request.headers.get('content-length'))>8_000_000)return new Response('Too large',{status:413});
   const text=await request.text();if(text.length>8_000_000)return new Response('Too large',{status:413});
   const body=JSON.parse(text);const signal=AbortSignal.any([request.signal,controller.signal]);
   let release!:()=>void;const previous=tail;const turn=new Promise<void>(resolve=>{release=resolve;});tail=previous.then(()=>turn);
   try {
    await Promise.race([previous,new Promise<never>((_,reject)=>{if(signal.aborted)return reject(signal.reason);signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})]);signal.throwIfAborted();
    if(path==='/capture')return Response.json(await draft.port.capture(body.states,signal));
    if(path==='/check'||path==='/acceptance')return Response.json(await acceptance.check({...body,runtime:httpCandidateRuntime(body.runtime,config.allowedOrigins,signal),signal}));
    if(path==='/state-capture') {
     const value=await acceptance.captureState({title:body.state.title,steps:body.state.steps,runtime:httpCandidateRuntime(body.runtime,config.allowedOrigins,signal),viewport:body.viewport,signal});
     return Response.json(await fidelity.adoptCapture(value));
    }
    if(path==='/fidelity-capture')return Response.json(await fidelity.port.capture({...body,signal}));
    return Response.json(await fidelity.port.compare({...body,signal}));
   }finally{release();}
  }catch{return new Response('The browser check did not complete',{status:422});}
  finally{clearTimeout(timeout);request.signal.removeEventListener('abort',abort);}
 };
 return {fetch:fetchRequest,close:async()=>{await acceptance.close();await fidelity.close();await draft.close();await browser.close();}};
}
if(import.meta.main) {
 const path=process.argv[2];if(!path)throw new Error('Pass a private browser config path');
 const config=JSON.parse(await readFile(path,'utf8'));
 if(!Number.isSafeInteger(config.port)||config.port<1024)throw new Error('Invalid browser port');
 const service=await openBrowserCheckService({...config,allowedOrigins:config.allowedOrigins??['http://localhost:5176','http://127.0.0.1:5176']});
 Bun.serve({hostname:'127.0.0.1',port:config.port,idleTimeout:120,fetch:service.fetch});
 console.log(`Private browser checks ready on 127.0.0.1:${config.port}`);
}
