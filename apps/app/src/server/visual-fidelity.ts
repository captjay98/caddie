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
      const built = await bounded(() => input.port!.capture({ document: input.builtDocument, documentHash: input.identity.builtDocumentHash, viewport, kind: 'built', identity: input.identity, operationKey: `${key}:built`, signal }));
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

/** Compare the approved key screen, never a later unapproved revision. More
 * journeys need independently mapped routes/fixtures; this is appearance only.
 */
export function approvedAppearanceDocument(body: string): string | null {
  const screen = splitDesignMocks(body).mocks[0];
  const theme = parseAppTheme(body);
  if (!screen || !theme.ok) return null;
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}"><style>:root{${themeToCssVars(theme.theme)}}*,*::before,*::after{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--text);font-family:var(--font-body);font-size:14px;line-height:1.45}</style></head><body>${screen.html}</body></html>`;
}
