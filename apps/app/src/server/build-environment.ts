import type { D1Database } from './auth.ts';
import { ScopeError } from './scope.ts';
import { restoreCompatibility } from './build-resume-context.ts';
export interface BuildEnvironment { runId:string; projectId:string; stackId:string; recipeVersion:string; baseImage:string; }
/** Stamped before the first sandbox effect of a versioned admission. A fresh
 * context/process reads the same identity. The mutable working checkpoint is
 * deliberately not compared with the base image: normal edits/rollback differ.
 */
export async function assertBuildEnvironment(db:D1Database,input:BuildEnvironment):Promise<void> {
 await db.prepare('insert or ignore into build_environments(runId,projectId,stackId,recipeVersion,baseImage,createdAt) values(?,?,?,?,?,?)')
  .bind(input.runId,input.projectId,input.stackId,input.recipeVersion,input.baseImage,new Date().toISOString()).run();
 const record=(await db.prepare('select * from build_environments where runId=? and projectId=?').bind(input.runId,input.projectId).all<BuildEnvironment>()).results[0];
 if(!record) throw new ScopeError(409,'BUILD_ENVIRONMENT_CHANGED','The saved build environment could not be identified. Your work is retained.');
 const verdict=restoreCompatibility({expectedStack:record.stackId,restoredStack:input.stackId,
  expectedRecipeVersion:record.recipeVersion,restoredRecipeVersion:input.recipeVersion,
  expectedCheckpointRef:null,availableCheckpointRef:null});
 if(!verdict.ok || record.baseImage!==input.baseImage)
  throw new ScopeError(409,'BUILD_ENVIRONMENT_CHANGED','The build environment changed since this work started. Your plan and saved files are retained.');
}
