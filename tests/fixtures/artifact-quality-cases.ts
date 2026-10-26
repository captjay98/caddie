import { migratedDatabase, addUser } from './sqlite-d1.ts';
import { createWorkspace, createProject } from '../../apps/app/src/server/projects.ts';
import { workspaceScopeForUser, projectScopeForUser } from '../../apps/app/src/server/scope.ts';
import { ensureWorkflow } from '../../apps/app/src/server/build-workflow.ts';
import { admitQualityProject } from '../../apps/app/src/server/artifact-quality.ts';
export async function qualityWorld(enabled=true) {
 const {sqlite,db}=migratedDatabase();addUser(sqlite,'quality-user','quality@example.test');
 const workspace=await createWorkspace(db,'quality-user',{name:'Quality review'});
 const ws=await workspaceScopeForUser(db,'quality-user',workspace.id);
 const project=await createProject(db,ws,{workspaceId:workspace.id,name:'Farm log',description:'Record farm observations and keep them after reloading.'});
 const scope=await projectScopeForUser(db,'quality-user',project.id);
 const workflow=await ensureWorkflow(db,scope);
 if(enabled)await admitQualityProject(db,project.id,{CADDIE_QUALITY_POLICY:'quality-v1'});
 return {db,sqlite,project,scope,workflow};
}
export const GOOD_PLAN='# Farm log\n\nRecord feed, review it, and save it to the server. Show a useful retry if saving fails.';
export const BAD_PLAN='# Farm log\n\nThe agent approves itself. Data can disappear after reload.';
