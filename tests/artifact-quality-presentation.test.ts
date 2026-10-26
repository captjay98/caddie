import {expect,test} from 'bun:test';
import {isDraftArtifact} from '../apps/app/src/client/conversation/draft-artifact.ts';
test('raw drafts and mock markup are guarded while ordinary conversation stays readable',()=>{
 expect(isDraftArtifact('# Farmhand — Product Requirements Document (v2)\nPlan body')).toBe(true);
 expect(isDraftArtifact('Here is a draft:\n```html-mock Home\n<main>Draft</main>\n```')).toBe(true);
 expect(isDraftArtifact('```caddie-features\n[]\n```')).toBe(true);
 expect(isDraftArtifact('Your entry is saved. You can review the design brief from the project.')).toBe(false);
});
