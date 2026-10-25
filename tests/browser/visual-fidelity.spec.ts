import { expect, test } from '@playwright/test';
import { openLocalVisualFidelity } from '../../scripts/local-visual-fidelity.ts';
import { previewDocument } from '../../apps/app/src/server/built-app.ts';
import { documentHash, reviewVisualFidelity } from '../../apps/app/src/server/visual-fidelity.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const screen = (offset = 0, overflow = false) => `<!doctype html><html><head><style>html,body{margin:0;font-family:Arial;background:#10141b;color:white}main{padding:24px;transform:translateY(${offset}px);${overflow ? 'min-width:1800px;' : ''}}article{padding:24px;border-radius:12px;background:#21394b;max-width:600px}button{height:48px;background:#5daaff;border:0;border-radius:12px;padding:0 24px}</style></head><body><main><h1>Your farm today</h1><article><h2>Feed on hand</h2><p>8 days left</p><button>Record feed</button></article></main></body></html>`;

function builtScreen(offset = 0, overflow = false) {
  const html = screen(offset, overflow);
  const css = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
  const body = html.match(/<body>([\s\S]*?)<\/body>/)![1]!;
  // An executed single-file build, through the same previewDocument builder
  // as verify_build, not a second static screenshot standing in for an app.
  return previewDocument({ css, js: `document.getElementById("root").innerHTML = ${JSON.stringify(body)};` });
}

test('real Chromium captures match unchanged screens and reject shifted or overflowing built layouts', async ({ browser }, testInfo) => {
  const local = await openLocalVisualFidelity({ browser, directory: join(tmpdir(), 'caddie-local-fidelity', testInfo.testId) });
  try {
    const approved = screen();
    const identity = { projectId: 'local-fixture', planRevisionId: 'approved-plan', designRevisionId: 'approved-design', designHash: await documentHash(approved), buildImage: 'local-built-bundle', builtDocumentHash: await documentHash(builtScreen()) };
    const matched = await reviewVisualFidelity({ identity, approvedDocument: approved, builtDocument: builtScreen(), operationKey: 'unchanged', port: local.port });
    expect(matched.status).toBe('passed');
    expect(matched.viewports.map((view) => [view.built.width, view.built.height])).toEqual([[390, 844], [1440, 900]]);
    for (const view of matched.viewports) await testInfo.attach(`matching-${view.viewport.name}`, { path: view.built.artifact, contentType: 'image/png' });
    for (const [key, built] of [['shifted', builtScreen(80)], ['overflow', builtScreen(0, true)]] as const) {
      const rejected = await reviewVisualFidelity({ identity: { ...identity, builtDocumentHash: await documentHash(built) }, approvedDocument: approved, builtDocument: built, operationKey: key, port: local.port });
      expect(rejected.status).toBe('needs-repair');
      expect(rejected.viewports).toHaveLength(2);
      if (key === 'overflow') expect(rejected.viewports[0]!.differences.some((difference) => difference.area === 'overflow')).toBe(true);
      for (const view of rejected.viewports) await testInfo.attach(`${key}-${view.viewport.name}`, { path: view.built.artifact, contentType: 'image/png' });
    }
  } finally { await local.close(); }
});
