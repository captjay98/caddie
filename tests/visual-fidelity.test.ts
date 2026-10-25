import { describe, expect, test } from 'bun:test';
import { documentHash, FIDELITY_VIEWPORTS, reviewVisualFidelity, type FidelityIdentity, type FidelityPort } from '../apps/app/src/server/visual-fidelity.ts';

const approved = '<main>Record feed</main>';
const built = '<main>Record feed</main>';
async function input() {
  return { identity: { projectId: 'project', planRevisionId: 'plan-1', designRevisionId: 'design-2', designHash: await documentHash(approved), buildImage: 'checked-image', builtDocumentHash: await documentHash(built) } satisfies FidelityIdentity, approvedDocument: approved, builtDocument: built, operationKey: 'verify-1' };
}
function port(differences: Array<{ severity: 'blocking' | 'advisory'; area: 'layout'; message: string }> = []) {
  const calls: string[] = [];
  const adapter: FidelityPort = {
    capture: async (request) => {
      calls.push(request.operationKey);
      return { artifact: `private:${request.operationKey}`, sha256: await documentHash(request.document), documentHash: request.documentHash, width: request.viewport.width, height: request.viewport.height, capturedAt: new Date().toISOString() };
    },
    compare: async (request) => { calls.push(request.operationKey); return { differences }; },
  };
  return { adapter, calls };
}
describe('host-owned built versus approved appearance gate', () => {
  test('missing adapter is explicitly not checked, never a visual pass', async () => {
    const outcome = await reviewVisualFidelity(await input());
    expect(outcome.status).toBe('not-checked');
    expect(outcome.viewports).toHaveLength(0);
    expect(outcome.reason).toContain('not configured');
  });
  test('requires approved design and the checked document identity', async () => {
    const { adapter, calls } = port();
    const source = await input();
    expect((await reviewVisualFidelity({ ...source, approvedDocument: null, port: adapter })).status).toBe('not-checked');
    expect((await reviewVisualFidelity({ ...source, builtDocument: 'a newer unchecked app', port: adapter })).status).toBe('not-checked');
    expect(calls).toHaveLength(0);
  });
  test('captures approved and actual pixels at BOTH real viewports before passing', async () => {
    const { adapter, calls } = port();
    const outcome = await reviewVisualFidelity({ ...await input(), port: adapter });
    expect(outcome.status).toBe('passed');
    expect(outcome.viewports.map((view) => view.viewport)).toEqual([...FIDELITY_VIEWPORTS]);
    expect(calls).toEqual(['verify-1:phone:approved', 'verify-1:phone:built', 'verify-1:phone:compare', 'verify-1:desktop:approved', 'verify-1:desktop:built', 'verify-1:desktop:compare']);
  });
  test('a layout mismatch creates a focused repair result and preserves screenshots', async () => {
    const { adapter } = port([{ severity: 'blocking', area: 'layout', message: 'The primary record action is missing from the first screen.' }]);
    const outcome = await reviewVisualFidelity({ ...await input(), port: adapter });
    expect(outcome.status).toBe('needs-repair');
    expect(outcome.viewports).toHaveLength(2);
    expect(outcome.viewports[0]!.built.artifact).toContain(':phone:built');
  });
  test('advisories are retained without blocking an otherwise matched appearance', async () => {
    const { adapter } = port([{ severity: 'advisory', area: 'layout', message: 'The heading wraps one line earlier.' }]);
    const outcome = await reviewVisualFidelity({ ...await input(), port: adapter });
    expect(outcome.status).toBe('passed');
    expect(outcome.viewports[1]!.differences).toHaveLength(1);
  });
  test('stale screenshots and wrong-sized captures never pass', async () => {
    for (const wrong of [{ documentHash: '0'.repeat(64) }, { width: 1280 }, { sha256: 'the model said it passed' }, { artifact: '' }]) {
      const { adapter } = port();
      const capture = adapter.capture;
      adapter.capture = async (request) => ({ ...await capture(request), ...wrong });
      expect((await reviewVisualFidelity({ ...await input(), port: adapter })).status).toBe('not-checked');
    }
  });
  test('invalid comparison or browser failure never becomes a pass and does not leak error secrets', async () => {
    const { adapter } = port();
    adapter.compare = async () => ({ differences: [] as never, passed: true });
    // An empty list really means no differences; malformed/absent lists do not.
    adapter.compare = async () => ({ differences: null as never });
    expect((await reviewVisualFidelity({ ...await input(), port: adapter })).status).toBe('not-checked');
    adapter.capture = async () => { throw new Error('https://private.invalid?token=secret'); };
    const outcome = await reviewVisualFidelity({ ...await input(), port: adapter });
    expect(outcome.status).toBe('not-checked');
    expect(JSON.stringify(outcome)).not.toContain('secret');
  });
  test('user cancellation propagates rather than publishing a preview after stopping', async () => {
    const { adapter } = port();
    const abort = new AbortController();
    adapter.capture = async () => { abort.abort(); throw abort.signal.reason; };
    await expect(reviewVisualFidelity({ ...await input(), port: adapter, signal: abort.signal })).rejects.toThrow();
  });
});

import { approvedAppearanceDocuments } from '../apps/app/src/server/visual-fidelity.ts';
import { lookThemeBlock } from '@caddie/contracts';

// B06.3 — the visual gate must cover failure/recovery states, not only the
// happy-path first screen. The design body may carry one titled html-mock per
// screen OR STATE (contracts: "Today · empty"); the gate should compare each,
// so an app whose error/empty state is broken cannot pass on a good home screen.
describe('B06.3 — approved appearance covers every designed state, not only the first', () => {
  const FIELD = {
    id: 'field', name: 'Field-ready', why: 'Readable in sun.',
    colors: { bg: '#F7F5EF', surface: '#FFFFFF', text: '#1B1F1A', muted: '#5A6157', primary: '#1F7A3A', onPrimary: '#FFFFFF', border: '#D9D6CC', ok: '#1F7A3A', warn: '#9A4A00', danger: '#B42318' },
    fonts: { heading: 'system-ui, sans-serif', body: 'system-ui, sans-serif' },
    radius: 10, density: 'roomy',
  };
  const body = () =>
    `# Approved design\n\n${lookThemeBlock(FIELD as never)}\n\n` +
    '```html-mock Today\n<main><h1>Today</h1></main>\n```\n\n' +
    '```html-mock Today · empty\n<main><p>No entries yet</p></main>\n```\n';

  test('returns one document per designed state, each carrying its own markup', () => {
    const docs = approvedAppearanceDocuments(body());
    expect(docs.length).toBe(2);
    expect(docs[0]!.title).toBe('Today');
    expect(docs[0]!.document).toContain('<h1>Today</h1>');
    expect(docs[1]!.title).toBe('Today · empty');
    expect(docs[1]!.document).toContain('No entries yet');
  });
});
