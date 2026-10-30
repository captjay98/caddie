/** Dedicated hosted preview entry: deliberately no Caddie assets, auth router,
 * agent classes or session secrets. Local Vite uses the same host firewall. */
import {isolatedPreviewRequest,type IsolatedPreviewEnv} from './server/isolated-preview.ts';
export default {
 async fetch(request:Request,env:IsolatedPreviewEnv):Promise<Response> {
  return await isolatedPreviewRequest(request,env)??new Response('Not found',{status:404});
 },
};
