import { parseAppTheme, splitDesignMocks, themeToCssVars } from '@caddie/contracts';

/** Host-only visual review. Agents never supply screenshots or a pass verdict.
 * A port must render the exact checked document in an isolated browser, save
 * the captured pixels, and compare them with the approved reference. No port
 * means NOT CHECKED, not a successful visual review or a broken usable build.
 */
export const FIDELITY_VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 900 },
] as const;
export type FidelityViewport = (typeof FIDELITY_VIEWPORTS)[number];
export interface FidelityIdentity {
  projectId: string;
  planRevisionId: string;
  designRevisionId: string;
  designHash: string;
  buildImage: string;
  builtDocumentHash: string;
}
export interface VisualCapture {
  /** Host-owned immutable saved PNG, not a model-written explanation. */
  artifact: string;
  sha256: string;
  documentHash: string;
  width: number;
  height: number;
  capturedAt: string;
}
export interface VisualDifference {
  severity: 'blocking' | 'advisory';
  area: 'layout' | 'content' | 'controls' | 'overflow' | 'appearance';
  message: string;
}
export interface FidelityPort {
  /** A host browser runner must actually navigate/render this approved state.
   * Merely screenshotting the home page for every state is not coverage. */
  captureState?: (input: { document:string;documentHash:string;viewport:FidelityViewport;kind:'built';identity:FidelityIdentity;operationKey:string;stateId:string;signal?:AbortSignal })=>Promise<VisualCapture>;
  capture(input: { document: string; documentHash: string; viewport: FidelityViewport; kind: 'approved' | 'built'; identity: FidelityIdentity; operationKey: string; signal?: AbortSignal }): Promise<VisualCapture>;
  compare(input: { approved: VisualCapture; built: VisualCapture; viewport: FidelityViewport; identity: FidelityIdentity; operationKey: string; signal?: AbortSignal }): Promise<{ differences: VisualDifference[] }>;
}
export interface FidelityResult {
  status: 'passed' | 'needs-repair' | 'not-checked';
  identity: FidelityIdentity;
  reason: string;
  viewports: Array<{ viewport: FidelityViewport; approved: VisualCapture; built: VisualCapture; differences: VisualDifference[] }>;
}
export async function documentHash(document: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(document))), (b) => b.toString(16).padStart(2, '0')).join('');
}
const HEX = /^[a-f0-9]{64}$/;
function validCapture(capture: VisualCapture, hash: string, viewport: FidelityViewport): boolean {
  return Boolean(capture && typeof capture.artifact === 'string' && capture.artifact.length > 0 && capture.artifact.length <= 2048 && HEX.test(capture.sha256) && capture.documentHash === hash && capture.width === viewport.width && capture.height === viewport.height && Number.isFinite(Date.parse(capture.capturedAt)));
}
function validDifferences(value: unknown): value is VisualDifference[] {
  return Array.isArray(value) && value.length <= 30 && value.every((entry) => entry && ['blocking', 'advisory'].includes(entry.severity) && ['layout', 'content', 'controls', 'overflow', 'appearance'].includes(entry.area) && typeof entry.message === 'string' && entry.message.trim().length > 0 && entry.message.length <= 1000);
}
/** A retry is one attempt in the existing host repair window, never an inner
 * unbounded model loop. A changed build/document always needs fresh captures.
 */
export async function reviewVisualFidelity(input: {
  identity: FidelityIdentity;
  approvedDocument: string | null;
  builtDocument: string;
  operationKey: string;
  port?: FidelityPort;
  signal?: AbortSignal;
  stateId?: string;
}): Promise<FidelityResult> {
  const result: FidelityResult = { status: 'not-checked', identity: input.identity, reason: '', viewports: [] };
  if (!input.approvedDocument) return { ...result, reason: 'The approved design has no saved appearance preview to compare.' };
  if (!input.port) return { ...result, reason: 'The browser appearance check is not configured. Build and behavior checks are separate.' };
  if (!/^(?:sha256-)?[a-f0-9]{64}$/.test(input.identity.designHash) || !input.identity.designRevisionId || !input.identity.buildImage || await documentHash(input.builtDocument) !== input.identity.builtDocumentHash)
    return { ...result, reason: 'The design or build identity could not be verified.' };
  const approvedDocument = input.approvedDocument;
  const approvedHash = await documentHash(approvedDocument);
  const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(60_000)]);
  const bounded = <T>(task: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    if (signal.aborted) return aborted();
    signal.addEventListener('abort', aborted, { once: true });
    task().then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
  try {
    for (const viewport of FIDELITY_VIEWPORTS) {
      input.signal?.throwIfAborted();
      const key = `${input.operationKey}:${viewport.name}`;
      const approved = await bounded(() => input.port!.capture({ document: approvedDocument, documentHash: approvedHash, viewport, kind: 'approved', identity: input.identity, operationKey: `${key}:approved`, signal }));
      const built = await bounded(() => (input.stateId ? input.port!.captureState! : input.port!.capture).call(input.port!,{ document: input.builtDocument, documentHash: input.identity.builtDocumentHash, viewport, kind: 'built', identity: input.identity, operationKey: `${key}:built`, signal, ...(input.stateId?{stateId:input.stateId}:{}) } as Parameters<NonNullable<FidelityPort['captureState']>>[0]));
      if (!validCapture(approved, approvedHash, viewport) || !validCapture(built, input.identity.builtDocumentHash, viewport)) return { ...result, reason: `The ${viewport.name} screenshot did not match this design, build and viewport.` };
      const compared = await bounded(() => input.port!.compare({ approved, built, viewport, identity: input.identity, operationKey: `${key}:compare`, signal }));
      if (!validDifferences(compared?.differences)) return { ...result, reason: `The ${viewport.name} appearance review returned an invalid result.` };
      result.viewports.push({ viewport, approved, built, differences: compared.differences });
    }
    const blocking = result.viewports.flatMap((view) => view.differences).some((difference) => difference.severity === 'blocking');
    return { ...result, status: blocking ? 'needs-repair' : 'passed', reason: blocking ? 'The built app differs from the approved design. Caddie needs to fix the highlighted differences.' : 'The built app matches the approved appearance at phone and desktop sizes.' };
  } catch (error) {
    input.signal?.throwIfAborted();
    // Do not store provider exception text: it can contain credentials or URLs.
    return { ...result, reason: 'The browser appearance check could not finish. No visual pass was recorded.' };
  }
}

/** Compare the approved key screen (the first designed state). Kept for
 * callers that want only the home screen; multi-state review uses
 * approvedAppearanceDocuments. */
export function approvedAppearanceDocument(body: string): string | null {
  return approvedAppearanceDocuments(body)[0]?.document ?? null;
}

/** Every designed state the gate should compare, not only the happy path: the
 * designer embeds one titled ```html-mock block per screen OR state (e.g.
 * "Today · empty", "Add entry · error"), so a broken error/empty state cannot
 * pass behind a good home screen (B06.3). Capped to bound capture cost. */
export const MAX_APPEARANCE_STATES = 24;
export function approvedAppearanceDocuments(body: string): Array<{ title: string; document: string }> {
  const theme = parseAppTheme(body);
  if (!theme.ok) return [];
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  const shell = (html: string) =>
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}"><style>:root{${themeToCssVars(theme.theme)}}*,*::before,*::after{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--text);font-family:var(--font-body);font-size:14px;line-height:1.45}</style></head><body>${html}</body></html>`;
  const mocks=splitDesignMocks(body).mocks;
  if(mocks.length>MAX_APPEARANCE_STATES) throw new Error('The complete design state inventory exceeds its capture allowance');
  return mocks.map((mock) => ({ title: mock.title, document: shell(mock.html) }));
}


export async function reviewVisualStateInventory(input:{identity:FidelityIdentity;approvedStates:readonly {title:string;document:string}[];builtDocument:string;operationKey:string;port?:FidelityPort;signal?:AbortSignal}):Promise<FidelityResult> {
 const unchecked=(reason:string):FidelityResult=>({status:'not-checked',identity:input.identity,reason,viewports:[]});
 if(!input.approvedStates.length || input.approvedStates.length>MAX_APPEARANCE_STATES)return unchecked('The full approved state inventory is missing or exceeds its allowance.');
 if(input.approvedStates.length>1&&!input.port?.captureState)return unchecked('The browser runner cannot yet check every approved screen and state. No complete visual pass was recorded.');
 const results:FidelityResult[]=[];
 for(let index=0;index<input.approvedStates.length;index++) {
  input.signal?.throwIfAborted();
  const state=input.approvedStates[index]!;
  const result=await reviewVisualFidelity({...input,approvedDocument:state.document,operationKey:`${input.operationKey}:state-${index+1}`,
   ...(input.port?.captureState?{stateId:state.title}:{})});
  if(result.status==='not-checked')return {...result,reason:`${state.title}: ${result.reason}`};
  results.push(result);
 }
 const failed=results.some(result=>result.status==='needs-repair');
 return {status:failed?'needs-repair':'passed',identity:input.identity,reason:failed?'An approved screen or state needs repair.':'Every declared screen/state was compared at phone and desktop sizes.',viewports:results.flatMap(result=>result.viewports)};
}
