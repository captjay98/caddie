import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
import {readFileSync} from 'node:fs';
import {sqliteD1} from './fixtures/sqlite-d1.ts';
import {applyFinalSchema} from './fixtures/migrations.ts';
import {openAcceptanceCandidate,resolveAcceptanceCandidate,closeAcceptanceCandidate} from '../apps/app/src/server/acceptance-candidate.ts';
function world(){
 const sqlite=new Database(':memory:');sqlite.exec(`create table projects(id text primary key,workspaceId text);insert into projects values('p','w');
 create table workspace_memberships(id text,userId text,workspaceId text);insert into workspace_memberships values('m','u','w');
 create table build_workflows(projectId text,runId text,phase text,planId text,spendPayerId text,approvedDesignRevisionId text);insert into build_workflows values('p','r','building','plan','payer','design');
 create table plan_doc_revisions(id text,bodyHash text);insert into plan_doc_revisions values('design','hash');
 create table approvals(projectId text,resourceId text,action text,policyVersion text,status text,revisionHash text,decidedBy text,expiresAt text);
 insert into approvals values('p','design','design','v1','approved','hash','u','2099-01-01T00:00:00.000Z');
 create table large_content(sha256 text primary key,bytes integer,chunks integer,createdAt text);create table large_content_chunks(sha256 text,idx integer,bytes blob,primary key(sha256,idx));`);
 applyFinalSchema(sqlite);return {sqlite,db:sqliteD1(sqlite)};
}
const scope={actorId:'u',workspaceId:'w',projectId:'p'},identity={projectId:'p',runId:'r',admissionId:'payer',planId:'plan',designId:'design',featureId:'f',checkedImage:'checked'};
test('private unpublished candidates bind exact bytes and reject stop/new admission/expired approval/revoked membership/expired capability/quota',async()=>{
 for(const mutation of ["update build_workflows set phase='blocked'","update build_workflows set spendPayerId='new'","update build_workflows set approvedDesignRevisionId='new'","delete from workspace_memberships","update approvals set status='revoked'","update approvals set expiresAt='2000-01-01'","update acceptance_candidates set expiresAt=0","update acceptance_candidates set requestCount=512"]) {
  const {sqlite,db}=world();try{
   const candidate=await openAcceptanceCandidate(db,scope,identity,{document:'<p>Checked app</p>',server:'server',migrations:[]},'http://localhost:5176');
   expect((await resolveAcceptanceCandidate(db,candidate.token)).bundle.document).toBe(candidate.document);
   sqlite.exec(mutation);await expect(resolveAcceptanceCandidate(db,candidate.token)).rejects.toThrow('No active checked candidate');
  }finally{sqlite.close();}
 }
});
test('closed candidates and wrong scope cannot be reopened; no public workflow output is created',async()=>{
 const {sqlite,db}=world();try{
  await expect(openAcceptanceCandidate(db,{...scope,projectId:'x'},identity,{document:'app',server:null,migrations:[]},'http://localhost:5176')).rejects.toThrow();
  const candidate=await openAcceptanceCandidate(db,scope,identity,{document:'app',server:null,migrations:[]},'http://localhost:5176');
  await expect(resolveAcceptanceCandidate(db,'wrong')).rejects.toThrow();await closeAcceptanceCandidate(db,candidate.id);await expect(resolveAcceptanceCandidate(db,candidate.token)).rejects.toThrow();
  // The honest check is the row, not the table: the folded schema always
  // carries workflow_outputs, so absence of a public output is what matters.
  expect(sqlite.query('select count(*) n from workflow_outputs').get()).toEqual({n:0});
 }finally{sqlite.close();}
});
