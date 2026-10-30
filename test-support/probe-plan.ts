import { Database } from 'bun:sqlite';
import { parsePlanFeatures } from '@caddie/contracts';
const db = new Database('/tmp/devcopy.sqlite');
const plan = db.query("select body from plan_doc_revisions where projectId='proj_cc4f8588d6715d29166c5a65b45ccdbe' and kind='prd' order by revision desc limit 1").get() as { body: string };
const f = parsePlanFeatures(plan.body); if (!f.ok) throw new Error(f.error);
console.log(f.features.length, 'features', f.features.reduce((n, x) => n + x.doneWhen.length, 0), 'criteria', plan.body.length, 'chars');
for (const x of f.features) console.log('-', x.id, x.doneWhen.length, x.title);
