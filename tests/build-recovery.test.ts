import {expect,test} from 'bun:test';
import {classifyBuildFailure} from '../apps/app/src/server/build-recovery.ts';
test('unknown writes reconcile, cancellation stops, and quota is never a code repair or retry',()=>{
 expect(classifyBuildFailure({status:503,effectState:'reconciliation-required',readOnly:false}).action).toBe('reconcile-receipt');
 expect(classifyBuildFailure({status:429,code:'insufficient_quota',readOnly:true}).action).toBe('stop');
 expect(classifyBuildFailure({status:503,readOnly:true,cancelled:true}).kind).toBe('cancelled');
 expect(classifyBuildFailure({checkFailed:true}).action).toBe('repair-code');
 expect(classifyBuildFailure({status:503,readOnly:true}).action).toBe('retry-same-operation');
 expect(classifyBuildFailure({transportError:new TypeError('socket reset'),readOnly:true}).action).toBe('retry-same-operation');
 expect(classifyBuildFailure({transportError:new TypeError('socket reset'),readOnly:false}).action).toBe('stop');
});
