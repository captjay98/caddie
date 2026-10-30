import { readFileSync } from 'node:fs';
import { lookProposalIssues, parsePlanFeatures } from '@caddie/contracts';
import { Database } from 'bun:sqlite';
const db = new Database('/tmp/devcopy.sqlite');
const plan = db.query("select body from plan_doc_revisions where projectId='proj_cc4f8588d6715d29166c5a65b45ccdbe' and kind='prd' order by revision desc limit 1").get() as { body: string };
const f = parsePlanFeatures(plan.body); if (!f.ok) throw new Error(f.error);
console.log(lookProposalIssues(readFileSync('/tmp/farm-looks-body2.md', 'utf8'), { features: f.features }).join('\n'));
