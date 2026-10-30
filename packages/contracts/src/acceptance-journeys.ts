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
/** How a built app must route so the host's "open" step and the preview reach
 * its screens. The builder, the repair brief and the checker share this text. */
export const HASH_ROUTES_RULE='Route screens by location.hash: the screen at "/farm" is "#/farm". Read location.hash (empty means "#/"), re-render on the hashchange event, and move between screens by setting location.hash or with <a href="#/farm">. Never route by location.pathname or history.pushState: the preview frame\'s own address is never the app\'s, and Caddie\'s checks open each screen by setting location.hash.';
/** Every criterion runs alone in a fresh database with a brand-new person
 * (acceptance-runtime scopes each by session). 2026-10-30 EggOps: "open the
 * farm → sign in → See all days → expect 205" could never pass, because a new
 * person has no flock or counts; the builder burned four repair tries on it. */
export const JOURNEY_EMPTY_START_RULE='Each criterion runs ALONE on an empty app for a brand-new person: nothing another check saved is there. So its steps must first create, through the same screens a person uses, every record its expect needs (set up the farm, add the flock, load the example week, save a count) before expecting a number or a list. A click matches a button or link whose whole accessible name is exactly the given text, so name what the screen really labels ("See day 26 Oct", not a bare "205").';
export const ACCEPTANCE_JOURNEY_GUIDE=`Include one caddie-checks JSON fence in the design: {"version":1,"criteria":[{"featureId":"approved-feature-id","text":"exact approved doneWhen text","steps":[{"kind":"open","path":"/"},{"kind":"fill","label":"Observation","value":"{{marker}}"},{"kind":"click","name":"Save"},{"kind":"restart"},{"kind":"expect","text":"{{marker}}","visible":true}]}],"states":[{"title":"exact html-mock title","steps":[{"kind":"open","path":"/"},{"kind":"expect","text":"Your farm"}]}]}. Cover EVERY approved criterion and EVERY mock state exactly once. Steps are host-owned browser actions: open local hash path; fill accessible label; click button/link accessible name; expect visible/absent text; actor a/b using real app sign-in; offline true/false; reload; restart (fresh server isolate, same database, cleared browser cache); fault /api/path mode fail/hold/clear for error/loading states. Use {{marker}} for a unique record and {{number}} for a fresh numeric value. ${JOURNEY_EMPTY_START_RULE} Tests must exercise the promised behavior, not headings or a generic health check. Include persistence/restart, two-user isolation, offline/reconnect and error recovery when the scope requires them. No scripts, code, external URLs, arbitrary requests, assertions supplied by the builder, or changed criteria.`;
/** Whole numbers of two or more digits in a text ("1,240" → "1240"). */
function numbersIn(value:string):string[] {
 return [...value.replace(/\{\{(marker|number)\}\}/g,'').matchAll(/\d[\d,.]*\d|\d{2,}/g)].map(match=>match[0].replace(/[,.](?=\d{3}\b)/g,'')).filter(n=>/^\d{2,}/.test(n));
}
/**
 * Checks that can never pass, caught when the design is saved instead of
 * after several paid repair rounds (owner 2026-10-30, EggOps). Deliberately
 * narrow, so a sound check is never refused:
 *   - a click whose whole name is a number ("205"): a button is named by its
 *     label, and a number on screen is not one;
 *   - an expect of a number when the check types nothing and its own
 *     criterion never states that number: each check starts on an empty app,
 *     so nothing could have put it there ("reload → Look again → 205");
 *   - pressing Save or Submit before anything is typed: on an empty app there
 *     is nothing to save, so whatever the save would trigger (the tip, its
 *     "Try again") never happens.
 * Each line names the check and the fix.
 */
export function journeyLintIssues(manifest:AcceptanceJourneys):string[] {
 const out:string[]=[];
 manifest.criteria.forEach((criterion,index)=>{
  const where=`caddie-checks criteria[${index}] (${criterion.featureId})`;
  const filled=new Set(criterion.steps.flatMap(step=>step.kind==='fill'?numbersIn(step.value):[]));
  const typed=criterion.steps.some(step=>step.kind==='fill');
  const promised=new Set(numbersIn(criterion.text));
  criterion.steps.forEach((step,stepIndex)=>{
   if(step.kind==='click'&&/^(save|submit)\b/i.test(step.name.trim())&&!criterion.steps.slice(0,stepIndex).some(earlier=>earlier.kind==='fill'))
    out.push(`${where} step ${stepIndex+1} presses "${step.name}" before anything is typed. Each check starts on an empty app for a new person, so fill the fields this save needs first (for example {"kind":"fill","label":"Total eggs","value":"140"}).`);
   if(step.kind==='click'&&/^[\d\s.,:%₦$+-]+$/.test(step.name))
    out.push(`${where} step ${stepIndex+1} clicks "${step.name}", a number, not a button label. Click what the screen labels (for example "See day 26 Oct") or open that screen by its path.`);
   if(step.kind==='expect'&&step.visible!==false&&!typed){
    const lost=numbersIn(step.text).filter(n=>!promised.has(n)&&!filled.has(n));
    if(lost.length)
     out.push(`${where} step ${stepIndex+1} expects "${step.text}", but this check types nothing and its criterion never says ${lost[0]}. Each check starts on an empty app for a new person, so first fill the value (or tap the button that loads the example data the criterion names), or expect words the screen shows.`);
   }
  });
 });
 return out;
}
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
