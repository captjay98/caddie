import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { sqliteD1 } from './fixtures/sqlite-d1.ts';
import { recordCheckedRepair, repairRoute, repairState } from '../apps/app/src/server/repair-escalation.ts';
import { findModelRoute, routeAcceptsImage } from '../apps/app/src/agents/providers.ts';

// Exact migration, minimal parent tables: these tests exercise real transactions and constraints.
const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
 const sqlite = new Database(':memory:'); databases.push(sqlite);
 sqlite.exec(`create table projects(id text primary key); insert into projects values ('p');
 create table build_workflows(projectId text,runId text,planId text,spendPayerId text,phase text);
 create table build_features(runId text,planId text,featureId text,status text,position integer);
 insert into build_workflows values('p','r','plan','payer','building');
 insert into build_features values('r','plan','feature-1','building',1);`);
 sqlite.exec(readFileSync(new URL('../apps/app/migrations/0048_repair_escalation.sql', import.meta.url),'utf8'));
 sqlite.exec(`update build_workflows set repairPolicyVersion='repair-v1'`);
 return { sqlite, db: sqliteD1(sqlite) };
}
const failure = (key: string) => ({runId:'r',operationKey:key,issue:'feature-1:tests',detail:'failed test'});
describe('durable checked repair escalation', () => {
 test('two attempts per model, six total, with pinned priced routes', async () => {
  const {db,sqlite} = fixture();
  expect((await repairState(db,'r'))?.routeId).toBe('nemotron-3.5-super-vl');
  const routes=[];
  for(let i=1;i<=6;i++) routes.push((await recordCheckedRepair(db,failure(String(i))))?.routeId);
  expect(routes).toEqual(['nemotron-3.5-super-vl','deepseek-v4.1-flash-1017','deepseek-v4.1-flash-1017','glm-5.3','glm-5.3',null]);
  expect((await recordCheckedRepair(db,failure('7')))?.paused).toBe(true);
  expect(sqlite.query('select count(*) n from build_repair_attempts').get()).toEqual({n:6});
  expect(findModelRoute('deepseek-v4.1-flash-1017').modelId).toBe('deepseek-ai/DeepSeek-V4.1-Flash-1017');
  expect(routeAcceptsImage('deepseek-v4.1-flash-1017')).toBe(true);
  expect(routeAcceptsImage('glm-5.3')).toBe(false);
 });
 test('replayed receipt and renamed error do not reset or duplicate counters', async () => {
  const {db}=fixture();
  await recordCheckedRepair(db,failure('same'));
  await recordCheckedRepair(db,failure('same'));
  expect((await repairState(db,'r'))?.failures).toBe(1);
  await recordCheckedRepair(db,{...failure('two'),issue:'feature-1:bundle'});
  expect((await repairState(db,'r'))?.routeId).toBe('deepseek-v4.1-flash-1017');
  expect((await repairState(db,'r'))?.failures).toBe(2);
 });
 test('fresh context keeps counters; stop refuses new failure receipts; explicit new payer gets a fresh window',async()=>{
  const {db,sqlite}=fixture();
  await recordCheckedRepair(db,failure('one'));await recordCheckedRepair(db,failure('two'));
  const reconnected=sqliteD1(sqlite);
  expect((await repairState(reconnected,'r'))?.failures).toBe(2);
  sqlite.exec("update build_workflows set phase='blocked'");
  expect(await recordCheckedRepair(db,failure('late'))).toBeNull();
  sqlite.exec("update build_workflows set phase='building',spendPayerId='new-payer'");
  expect((await repairState(db,'r'))?.failures).toBe(0);
  expect(await recordCheckedRepair(db,{...failure('late-old'),admissionId:'payer'})).toBeNull();
  expect((await repairState(db,'r'))?.failures).toBe(0);
 });
 test('legacy admission has no new policy; vision never falls through to text-only model',async()=>{
  const {db,sqlite}=fixture();sqlite.exec('update build_workflows set repairPolicyVersion=null');
  expect(await recordCheckedRepair(db,failure('one'))).toBeNull();
  expect(repairRoute(3,true)).toBe('deepseek-v4.1-flash-1017');expect(repairRoute(4,true)).toBeNull();
  expect(repairRoute(Infinity)).toBeNull();expect(repairRoute(-1)).toBeNull();
 });
});
