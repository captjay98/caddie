/** Shared recovery classification. No provider text, credentials or private
 * reasoning crosses this boundary. Unknown write outcomes always reconcile. */
export type BuildFailureKind='transient-service'|'code-check'|'effect-unknown'|'needs-user'|'budget-exhausted'|'cancelled'|'unclassified';
export interface RecoveryDecision {kind:BuildFailureKind;action:'retry-same-operation'|'repair-code'|'reconcile-receipt'|'wait-for-user'|'stop';}
export function classifyBuildFailure(input:{status?:number;code?:string;cancelled?:boolean;effectState?:string;readOnly?:boolean;transportError?:unknown;checkFailed?:boolean}):RecoveryDecision {
 if(input.cancelled)return {kind:'cancelled',action:'stop'};
 if(['dispatched','ambiguous','reconciliation-required','cancel-requested'].includes(input.effectState??''))return {kind:'effect-unknown',action:'reconcile-receipt'};
 if(['insufficient_quota','quota_exhausted','quota_exceeded','budget_exhausted','budget_denied','spend_limit_reached','BUILD_DEADLINE_EXHAUSTED'].includes(input.code??''))return {kind:'budget-exhausted',action:'stop'};
 if(['invalid_api_key','permission_denied','APPROVAL_REQUIRED','APPROVAL_EXPIRED','APPROVAL_REVOKED'].includes(input.code??'') || input.status===401 || input.status===403)return {kind:'needs-user',action:'wait-for-user'};
 if(input.checkFailed)return {kind:'code-check',action:'repair-code'};
 const network=input.transportError instanceof TypeError || (input.transportError instanceof Error && /socket|network|connection|fetch failed/i.test(input.transportError.message));
 if(input.readOnly && (network||input.status===408||input.status===409||input.status===429||(input.status!==undefined&&input.status>=500&&input.status<=599)))return {kind:'transient-service',action:'retry-same-operation'};
 return {kind:'unclassified',action:'stop'};
}
export class BuildRecoveryError extends Error {
 constructor(readonly decision:RecoveryDecision){super(`Build service recovery: ${decision.kind}`);this.name='BuildRecoveryError';}
}
