import { readFileSync } from 'node:fs';
import { parseLooks, splitChecksBlock, designFromLook, splitDesignMocks } from '@caddie/contracts';
const body = readFileSync('/tmp/farm-looks-body2.md', 'utf8');
const p = parseLooks(body); if (!p.ok) { console.log('parse error', p.error); process.exit(0); }
console.log('looks', p.set.looks.map((l) => [l.id, l.screen?.title, l.screen?.html.length]));
const checks = JSON.parse(splitChecksBlock(body).raw!);
console.log('states', JSON.stringify(checks.states));
const d = designFromLook(body, p.set, p.set.looks[0]!);
console.log('mock titles in composed design', splitDesignMocks(d).mocks.map((m) => m.title));
console.log('prose has html-mock?', /```html-mock/.test(p.set.display), p.set.display.slice(0, 300));
