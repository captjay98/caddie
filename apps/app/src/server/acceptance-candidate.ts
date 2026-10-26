import {createHash,randomBytes} from 'node:crypto';
import type {Scope} from '@caddie/contracts';
import type {D1Database} from './auth.ts';
import {assertProjectScope,ScopeError} from './scope.ts';
import {getLarge,putLarge} from './large-content.ts';
import type {AcceptanceIdentity} from './independent-acceptance.ts';
export interface AcceptanceBundle {document:string;server:string|null;migrations:Array<{name:string;sql:string}>;}
export interface RuntimeCandidate {id:string;url:string;token:string;document:string;}
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
export async function openAcceptanceCandidate(db:D1Database,scope:Scope,identity:AcceptanceIdentity,bundle:AcceptanceBundle,origin:string):Promise<RuntimeCandidate> {
 await assertProjectScope(db,scope);
 if(identity.projectId!==scope.projectId)throw new ScopeError(403,'CANDIDATE_SCOPE','The checked candidate belongs to another project.');
 const token=randomBytes(32).toString('hex');const id=`ac_${randomBytes(16).toString('hex')}`;
 const blob=await putLarge(db,new TextEncoder().encode(JSON.stringify(bundle)));
 await db.prepare(`insert into acceptance_candidates(id,tokenHash,projectId,actorId,workspaceId,runId,admissionId,planId,designId,checkedImage,bundleHash,expiresAt,createdAt)
 select ?,?,?,?,?,?,?,?,?,?,?,?,? where exists(select 1 from build_workflows where projectId=? and phase='building' and runId=? and planId=? and spendPayerId=? and approvedDesignRevisionId=?)`)
 .bind(id,hash(token),scope.projectId,scope.actorId,scope.workspaceId,identity.runId,identity.admissionId,identity.planId,identity.designId,identity.checkedImage,blob.sha256,Date.now()+10*60_000,new Date().toISOString(),scope.projectId,identity.runId,identity.planId,identity.admissionId,identity.designId).run();
 const saved=(await db.prepare('select id from acceptance_candidates where id=?').bind(id).all()).results[0];if(!saved)throw new ScopeError(409,'STALE_BUILD','The candidate no longer belongs to this build.');
 const url=new URL('/api/acceptance-runtime',origin);
 return {id,url:url.href,token,document:bundle.document};
}
export async function closeAcceptanceCandidate(db:D1Database,id:string){await db.prepare('update acceptance_candidates set closed=1 where id=?').bind(id).run();}
export async function resolveAcceptanceCandidate(db:D1Database,token:string) {
 if(!/^[a-f0-9]{64}$/.test(token))throw new ScopeError(404,'NOT_FOUND','No active checked candidate.');
 const tokenHash=hash(token);
 const updated=await db.prepare(`update acceptance_candidates set requestCount=requestCount+1 where tokenHash=? and closed=0 and expiresAt>? and requestCount<512
 and exists(select 1 from build_workflows w where w.projectId=acceptance_candidates.projectId and w.phase='building' and w.runId=acceptance_candidates.runId and w.planId=acceptance_candidates.planId and w.spendPayerId=acceptance_candidates.admissionId and w.approvedDesignRevisionId=acceptance_candidates.designId)
 and exists(select 1 from workspace_memberships m where m.workspaceId=acceptance_candidates.workspaceId and m.userId=acceptance_candidates.actorId)
 and exists(select 1 from approvals a join plan_doc_revisions d on d.id=a.resourceId where a.projectId=acceptance_candidates.projectId and d.id=acceptance_candidates.designId and a.action='design' and a.policyVersion='v1' and a.status='approved' and a.revisionHash=d.bodyHash and a.decidedBy=acceptance_candidates.actorId and a.expiresAt>=?)`).bind(tokenHash,Date.now(),new Date().toISOString()).run() as {meta?:{changes?:number}};
 if(updated.meta?.changes!==1)throw new ScopeError(404,'NOT_FOUND','No active checked candidate.');
 const record=(await db.prepare('select * from acceptance_candidates where tokenHash=?').bind(tokenHash).all<{id:string;projectId:string;epoch:number;bundleHash:string}>()).results[0]!;
 const bytes=await getLarge(db,record.bundleHash);if(!bytes)throw new ScopeError(404,'NOT_FOUND','The checked candidate is unavailable.');
 return {...record,bundle:JSON.parse(new TextDecoder().decode(bytes)) as AcceptanceBundle};
}
