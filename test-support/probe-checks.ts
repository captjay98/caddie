import * as v from 'valibot';
import { readFileSync } from 'node:fs';
import { AcceptanceJourneysSchema, splitChecksBlock } from '@caddie/contracts';
const body = readFileSync('/tmp/farm-looks-body.md', 'utf8');
const raw = splitChecksBlock(body).raw!;
const parsed = v.safeParse(AcceptanceJourneysSchema, JSON.parse(raw));
if (!parsed.success) for (const issue of parsed.issues.slice(0, 12)) console.log(issue.path?.map((p) => String(p.key)).join('.'), '→', issue.message, JSON.stringify(issue.input)?.slice(0, 120));
const j = JSON.parse(raw); console.log('criteria', j.criteria?.length, 'states', JSON.stringify(j.states)?.slice(0, 300));
