import {expect,test} from 'bun:test';
import {requestsDifferentProject,refersToExistingWork} from '../apps/app/src/shared/chat-intent.ts';
test('explicit new-project requests can be redirected before changing an existing project',()=>{
 for(const text of ['start a new project for farmers','Please create another app','I want you to build a different project']) expect(requestsDifferentProject(text)).toBe(true);
 for(const text of ['Add a new project button','Do not start a new app','Change the existing project','Build the inventory screen']) expect(requestsDifferentProject(text)).toBe(false);
});
test('an existing-plan reply is not evidence of intent to create another project',()=>{
 expect(refersToExistingWork('Yes, please put that AI idea into the plan and carry on')).toBe(true);
 expect(refersToExistingWork('Update this app please')).toBe(true);
 expect(refersToExistingWork('Start a new app for my street')).toBe(false);
});
