import { expect,test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { sqliteD1 } from './fixtures/sqlite-d1.ts';
import { assertBuildEnvironment } from '../apps/app/src/server/build-environment.ts';
test('a reconstructed build keeps its recipe; mismatched stack, base and recipe are refused',async()=>{
 const sqlite=new Database(':memory:');
 try {
  sqlite.exec('create table projects(id text primary key);insert into projects values(\'p\');');
  sqlite.exec(readFileSync(new URL('../apps/app/migrations/0049_build_environment.sql',import.meta.url),'utf8'));
  const input={runId:'r',projectId:'p',stackId:'react-hono',recipeVersion:'1.0.0',baseImage:'tag:base:1'};
  await assertBuildEnvironment(sqliteD1(sqlite),input);
  await assertBuildEnvironment(sqliteD1(sqlite),input);
  for(const change of [{stackId:'flutter'},{recipeVersion:'2.0.0'},{baseImage:'tag:base:2'},{projectId:'other'}])
   await expect(assertBuildEnvironment(sqliteD1(sqlite),{...input,...change})).rejects.toThrow('environment');
  expect(sqlite.query('select count(*) n from build_environments').get()).toEqual({n:1});
 } finally {sqlite.close();}
});
