import {expect,test} from 'bun:test';
import {presentDesign} from '../apps/app/src/client/planning/design-presentation.ts';
test('saved design presentation names untitled screens and removes empty machinery headings without changing markup',()=>{
 const html='<main><h1>Inventory</h1><p>Original content</p></main>';
 const result=presentDesign('# Design\n## Theme (caddie-theme)\n## html-mock: Inventory\n```html-mock\n'+html+'\n```\n## Empty states\nNo stock yet.');
 expect(result.mocks).toEqual([{title:'Inventory',html}]);
 expect(result.notes).not.toContain('html-mock:');
 expect(result.notes).not.toContain('caddie-theme');
 expect(result.notes).toContain('No stock yet.');
});
