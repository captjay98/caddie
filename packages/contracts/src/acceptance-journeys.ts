import * as v from 'valibot';
import {splitDesignMocks} from './features.ts';
const text=(max:number)=>v.pipe(v.string(),v.trim(),v.minLength(1),v.maxLength(max));
const path=v.pipe(text(300),v.regex(/^\/(?!\/)[^\\]*$/));
export const AcceptanceStepSchema=v.variant('kind',[
 v.strictObject({kind:v.literal('open'),path}),
 v.strictObject({kind:v.literal('fill'),label:text(100),value:text(300)}),
 v.strictObject({kind:v.literal('click'),name:text(100)}),
 v.strictObject({kind:v.literal('expect'),text:text(300),visible:v.optional(v.boolean(),true)}),
 v.strictObject({kind:v.literal('actor'),user:v.picklist(['a','b'])}),
 v.strictObject({kind:v.literal('offline'),value:v.boolean()}),
 v.strictObject({kind:v.literal('reload')}),
 v.strictObject({kind:v.literal('restart')}),
 v.strictObject({kind:v.literal('fault'),path:v.pipe(text(300),v.regex(/^\/api\//)),mode:v.picklist(['fail','hold','clear'])}),
]);
const steps=v.pipe(v.array(AcceptanceStepSchema),v.minLength(1),v.maxLength(24));
export const AcceptanceJourneysSchema=v.strictObject({
 version:v.literal(1),
 criteria:v.pipe(v.array(v.strictObject({featureId:text(48),text:text(1000),steps})),v.minLength(1),v.maxLength(100)),
 states:v.pipe(v.array(v.strictObject({title:text(120),steps})),v.minLength(1),v.maxLength(24)),
});
export type AcceptanceStep=v.InferOutput<typeof AcceptanceStepSchema>;
export type AcceptanceJourneys=v.InferOutput<typeof AcceptanceJourneysSchema>;
export const ACCEPTANCE_JOURNEY_GUIDE='Include one caddie-checks JSON fence in the design: {"version":1,"criteria":[{"featureId":"approved-feature-id","text":"exact approved doneWhen text","steps":[{"kind":"open","path":"/"},{"kind":"fill","label":"Observation","value":"{{marker}}"},{"kind":"click","name":"Save"},{"kind":"restart"},{"kind":"expect","text":"{{marker}}","visible":true}]}],"states":[{"title":"exact html-mock title","steps":[{"kind":"open","path":"/"},{"kind":"expect","text":"Your farm"}]}]}. Cover EVERY approved criterion and EVERY mock state exactly once. Steps are host-owned browser actions: open local hash path; fill accessible label; click button/link accessible name; expect visible/absent text; actor a/b using real app sign-in; offline true/false; reload; restart (fresh server isolate, same database, cleared browser cache); fault /api/path mode fail/hold/clear for error/loading states. Use {{marker}} for a unique record and {{number}} for a fresh numeric value. Tests must exercise the promised behavior, not headings or a generic health check. Include persistence/restart, two-user isolation, offline/reconnect and error recovery when the scope requires them. No scripts, code, external URLs, arbitrary requests, assertions supplied by the builder, or changed criteria.';
const fence=/^(`{3,}|~{3,})[ \t]*caddie-checks[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/gm;
export function parseAcceptanceJourneys(body:string,criteria?:readonly {featureId:string;text:string}[]):AcceptanceJourneys {
 const matches=[...body.matchAll(fence)];
 if(matches.length!==1||matches[0]![2]!.length>100_000)throw new Error('One bounded caddie-checks manifest is required');
 const parsed=v.safeParse(AcceptanceJourneysSchema,JSON.parse(matches[0]![2]!));if(!parsed.success)throw new Error('The browser check manifest is invalid');
 const manifest=parsed.output;const key=(item:{featureId:string;text:string})=>JSON.stringify([item.featureId,item.text]);
 const provided=new Set(manifest.criteria.map(key));if(provided.size!==manifest.criteria.length)throw new Error('Duplicate criterion mapping');
 if(criteria&&(criteria.length!==provided.size||criteria.some(item=>!provided.has(key(item)))))throw new Error('Every approved criterion must have its exact check mapping');
 if(manifest.criteria.some(item=>!item.steps.some(step=>step.kind==='expect')))throw new Error('Each criterion needs an observable assertion');
 const titles=splitDesignMocks(body).mocks.map(mock=>mock.title);
 const states=new Set(manifest.states.map(state=>state.title));
 if(states.size!==manifest.states.length||titles.length!==states.size||titles.some(title=>!states.has(title)))throw new Error('Every approved mock state needs its exact navigation mapping');
 return manifest;
}
