import {expect,test} from 'bun:test';
import {pausedPreparation,preparationRetryLabel} from '../apps/app/src/shared/preparation-stage.ts';
test('paused preparation labels preserve the actual stage and legacy builds',()=>{
 expect(pausedPreparation({phase:'blocked'},false)).toBe('plan');
 expect(pausedPreparation({phase:'blocked',looksBaseline:0},true)).toBe('looks');
 expect(pausedPreparation({phase:'blocked',looksBaseline:0,designBaseline:0},true)).toBe('design');
 expect(pausedPreparation({phase:'blocked',approvedDesignRevisionId:'approved',looksBaseline:0},true)).toBeNull();
 expect(pausedPreparation({phase:'blocked'},true)).toBeNull();
 expect(preparationRetryLabel('design')).toBe('Continue the design');
});
