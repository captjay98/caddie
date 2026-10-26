import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {validateReviewImages} from '../apps/app/src/server/design-review-capture.ts';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
test('review inventory requires exact documents and actual PNG bytes at both viewports',()=>{
 const states=[{id:'home',document:'<h1>Farm log</h1>'}];
 const images=([{viewport:'phone' as const,width:390,height:844},{viewport:'desktop' as const,width:1440,height:900}]).map(size=>{
  const png=readFileSync(new URL(`../docs/evidence/2026-10-25-model-validation/good-${size.width}.png`,import.meta.url));
  return {stateId:'home',...size,documentHash:hash(states[0]!.document),pngSha256:hash(png),pngBase64:png.toString('base64')};
 });
 // Existing real PNG fixtures test byte/manifest validation, not semantic fidelity to this document.
 validateReviewImages(states,images);
 expect(()=>validateReviewImages(states,images.slice(0,1))).toThrow();
 expect(()=>validateReviewImages(states,[images[0]!,images[0]!])).toThrow();
 expect(()=>validateReviewImages(states,images.map(image=>({...image,documentHash:'stale'})))).toThrow();
 expect(()=>validateReviewImages(states,images.map(image=>({...image,pngBase64:Buffer.from('description of a screenshot').toString('base64')})))).toThrow();
});
