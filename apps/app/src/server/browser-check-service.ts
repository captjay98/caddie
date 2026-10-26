import type {AcceptanceJourneys} from '@caddie/contracts';
import type {RuntimeCandidate} from './acceptance-candidate.ts';
import type {FidelityPort,VisualCapture} from './visual-fidelity.ts';
export interface BrowserCheckEnv {
 DESIGN_CAPTURE?:{fetch:(request:Request)=>Promise<Response>};
 DESIGN_CAPTURE_URL?:string;DESIGN_CAPTURE_TOKEN?:string;
}
/** One private host-owned runner. This is never exposed as an agent tool. */
export function configuredBrowserChecks(env:BrowserCheckEnv):{fetch:(request:Request)=>Promise<Response>}|undefined {
 if(env.DESIGN_CAPTURE)return env.DESIGN_CAPTURE;
 if(!env.DESIGN_CAPTURE_URL||!env.DESIGN_CAPTURE_TOKEN)return;
 const url=new URL(env.DESIGN_CAPTURE_URL);
 if(url.username||url.password||url.search||url.hash||(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))))throw new Error('Invalid private browser check endpoint');
 return {async fetch(request){return fetch(new Request(new URL(new URL(request.url).pathname,url),{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${env.DESIGN_CAPTURE_TOKEN}`},body:await request.text(),signal:request.signal}));}};
}
export function serviceFidelity(service:{fetch:(request:Request)=>Promise<Response>},runtime:RuntimeCandidate,journeys:AcceptanceJourneys):FidelityPort {
 const post=async(path:string,input:unknown,signal?:AbortSignal)=>{
  const response=await service.fetch(new Request(`https://caddie-capture.internal/${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input),signal}));
  if(!response.ok)throw new Error('The private browser check did not complete');return response.json();
 };
 return {
  async capture(input){return await post('fidelity-capture',input,input.signal) as VisualCapture;},
  async captureState(input){const state=journeys.states.find(state=>state.title===input.stateId);if(!state)throw new Error('Missing approved state navigation');return await post('state-capture',{...input,runtime,state},input.signal) as VisualCapture;},
  async compare(input){return await post('compare',input,input.signal) as Awaited<ReturnType<FidelityPort['compare']>>;},
 };
}
