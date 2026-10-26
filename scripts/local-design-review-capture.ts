/** Local, free Chromium capture behind the same private service contract used
 * by the Worker. Generated markup has no network or script capabilities. */
import {readFile} from 'node:fs/promises';
import {openLocalVisualFidelity} from './local-visual-fidelity.ts';
import {documentHash,FIDELITY_VIEWPORTS} from '../apps/app/src/server/visual-fidelity.ts';
import {validateReviewImages,type DesignReviewCapturePort} from '../apps/app/src/server/design-review-capture.ts';
import type {ReviewImage} from '@caddie/contracts';
export async function openLocalDesignReviewCapture(directory:string,browser?:import('@playwright/test').Browser) {
 const local=await openLocalVisualFidelity({directory,browser});
 const port:DesignReviewCapturePort={async capture(states,signal) {
  if(states.length===0||states.length>24)throw new Error('Invalid state inventory');
  const images:ReviewImage[]=[];
  for(const state of states)for(const viewport of FIDELITY_VIEWPORTS) {
   signal?.throwIfAborted();const hash=await documentHash(state.document);
   const capture=await local.port.capture({document:state.document,documentHash:hash,viewport,kind:'approved',
    identity:{projectId:'independent-design-review',planRevisionId:'candidate',designRevisionId:state.id,designHash:hash,buildImage:'not-built',builtDocumentHash:hash},operationKey:`draft:${state.id}:${hash}:${viewport.name}`,signal});
   const bytes=await readFile(capture.artifact);
   images.push({stateId:state.id,viewport:viewport.name,width:viewport.width,height:viewport.height,documentHash:hash,pngSha256:capture.sha256,pngBase64:bytes.toString('base64')});
  }
  validateReviewImages(states,images);return images;
 }};
 return {port,close:local.close};
}
