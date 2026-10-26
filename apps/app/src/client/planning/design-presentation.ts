import { splitArchitectureBlock, splitDesignMocks, splitDesignPrototype, splitThemeBlock } from '@caddie/contracts';

/** Presentation only: original stored revisions and approval hashes stay untouched. */
export function presentDesign(body: string) {
 const withoutMachine = splitDesignPrototype(splitArchitectureBlock(body).display);
 const {display, mocks} = splitDesignMocks(splitThemeBlock(withoutMachine.display).display);
 const clean = (text:string) => text.replace(/<[^>]*>/g, '').replace(/\p{Extended_Pictographic}|\uFE0F/gu, '').replace(/\s+/g,' ').trim();
 return {
  mocks: mocks.map(mock => ({...mock, title:/^Screen \d+$/.test(mock.title)
   ? clean(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/i.exec(mock.html)?.[1] ?? mock.title).slice(0,100) || mock.title : mock.title})),
  prototype: withoutMachine.prototype,
  notes: display.replace(/^(`{3,}|~{3,})[ \t]*caddie-checks[^\n]*\n[\s\S]*?\n\1[ \t]*$/gm,'').replace(/^#{1,6}\s*(?:Theme\s*\(caddie-theme\)|html-mock\s*:.*)\s*$/gim,'').replace(/\n{3,}/g,'\n\n').trim(),
 };
}
