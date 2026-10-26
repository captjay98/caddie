import { createHash } from 'node:crypto';
import type { ReviewImage } from '@caddie/contracts';
export interface ReviewState { id:string;document:string; }
export interface DesignReviewCapturePort {
 capture(states:readonly ReviewState[], signal?:AbortSignal):Promise<ReviewImage[]>;
}
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
/** Require real PNG bytes matching every declared state at both viewports. A
 * missing screenshot, stale document or duplicate cannot be replaced by prose.
 */
export function validateReviewImages(states:readonly ReviewState[],images:readonly ReviewImage[]):void {
 if(states.length===0 || states.length>24 || new Set(states.map(state=>state.id)).size!==states.length || images.length!==states.length*2)
  throw new Error('The complete screen/state capture inventory is required');
 const expected=new Map(states.map(state=>[state.id,hash(state.document)]));const seen=new Set<string>();
 for(const image of images) {
  const key=`${image.stateId}:${image.viewport}`;
  const dimensions=image.viewport==='phone'?[390,844]:image.viewport==='desktop'?[1440,900]:null;
  if(!dimensions || seen.has(key) || expected.get(image.stateId)!==image.documentHash || image.pngBase64.length>3_000_000)
   throw new Error('Invalid, stale or duplicate review capture');
  const bytes=Buffer.from(image.pngBase64,'base64');
  if(bytes.length<67 || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString('ascii',12,16)!=='IHDR' || bytes.toString('ascii',bytes.length-8,bytes.length-4)!=='IEND' || hash(bytes)!==image.pngSha256 ||
   image.width!==dimensions[0] || image.height!==dimensions[1] || bytes.readUInt32BE(16)!==image.width || bytes.readUInt32BE(20)!==image.height)
   throw new Error('Review capture must contain the matching PNG pixels and dimensions');
  seen.add(key);
 }
}

/** Private service binding, supplied by the deployment. No arbitrary external
 * URLs or browser tokens enter generated content or agent tools. */
export function serviceDesignReviewCapture(service:{fetch:(request:Request)=>Promise<Response>}):DesignReviewCapturePort {
 return {async capture(states,signal) {
  const response=await service.fetch(new Request('https://caddie-capture.internal/capture',{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify({states}),signal}));
  if(!response.ok)throw new Error('Design capture service did not finish');
  const images=await response.json() as ReviewImage[];validateReviewImages(states,images);return images;
 }};
}

/** Local development can use a loopback capture process; production should
 * bind the private capture service. Credentials are never part of a URL. */
export function configuredDesignCapture(env:{DESIGN_CAPTURE?:{fetch:(request:Request)=>Promise<Response>};DESIGN_CAPTURE_URL?:string;DESIGN_CAPTURE_TOKEN?:string}):DesignReviewCapturePort|undefined {
 if(env.DESIGN_CAPTURE)return serviceDesignReviewCapture(env.DESIGN_CAPTURE);
 if(!env.DESIGN_CAPTURE_URL || !env.DESIGN_CAPTURE_TOKEN)return undefined;
 const url=new URL(env.DESIGN_CAPTURE_URL);
 if(url.username||url.password||url.search||url.hash || (url.protocol!=='https:' && !(url.protocol==='http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname))))
  throw new Error('Invalid private design capture endpoint');
 return serviceDesignReviewCapture({async fetch(request) {
  return fetch(new Request(new URL('/capture',url),{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${env.DESIGN_CAPTURE_TOKEN}`},body:await request.text(),signal:request.signal}));
 }});
}
