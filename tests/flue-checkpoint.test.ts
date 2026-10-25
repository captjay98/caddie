import {test,expect} from 'bun:test';
import {createFlueClient} from '../apps/app/node_modules/@flue/sdk/dist/index.mjs';
test('the SDK resumes updates at the materialized history checkpoint instead of replaying from -1',async()=>{
 const offset='0000000000000000_0000000000000185';
 let seenResolve!:(url:URL)=>void;
 const seen=new Promise<URL>(resolve=>{seenResolve=resolve;});
 const fetcher=(async(input:RequestInfo|URL)=>{
  const url=new URL(input instanceof Request ? input.url : String(input));
  if(url.searchParams.get('view')==='history')return Response.json({v:1,conversationId:'test',offset,messages:[],settlements:[],before:null});
  seenResolve(url);
  return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(`event: control\ndata: {"streamNextOffset":"${offset}","upToDate":true}\n\n`));}}),{headers:{'content-type':'text/event-stream'}});
 }) as unknown as typeof fetch;
 const observation=createFlueClient({url:'https://caddie.test/agents/coordinator/test',fetch:fetcher}).observe({limit:40,live:'sse'});
 const unsubscribe=observation.subscribe(()=>{});
 let timer:ReturnType<typeof setTimeout>|undefined;
 try {
  const url=await Promise.race([seen,new Promise<never>((_,reject)=>timer=setTimeout(()=>reject(new Error('No update request')),1000))]);
  expect(url.searchParams.getAll('offset')).toEqual([offset]);
 } finally {clearTimeout(timer);unsubscribe();observation.close();}
});
