import * as v from 'valibot';

const Id = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,39}$/));
const Text = (max: number) => v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(max));
const Action = v.strictObject({ id: Id, label: Text(60), to: Id });
const Field = v.strictObject({ id: Id, label: Text(80), placeholder: v.optional(Text(120)) });
const Screen = v.strictObject({
 id: Id, title: Text(100), body: Text(1200),
 fields: v.optional(v.pipe(v.array(Field), v.maxLength(6)), []),
 actions: v.pipe(v.array(Action), v.minLength(1), v.maxLength(4)),
});
export const DesignPrototypeSchema = v.strictObject({
 title: Text(100), reason: Text(240), start: Id,
 screens: v.pipe(v.array(Screen), v.minLength(2), v.maxLength(8)),
});
export type DesignPrototype = v.InferOutput<typeof DesignPrototypeSchema>;
export const PROTOTYPE_INFO = 'caddie-prototype';
export const PROTOTYPE_GUIDE = 'Only when an important interaction needs trying before building, include one caddie-prototype JSON fence. This is a bounded sample journey, not a working app: {"title":"Try recording feed","reason":"Check the confirmation before saving","start":"entry","screens":[{"id":"entry","title":"Record feed","body":"Enter sample feed for this flock.","fields":[{"id":"quantity","label":"Feed in kg"}],"actions":[{"id":"review","label":"Review entry","to":"confirm"}]},{"id":"confirm","title":"Check your entry","body":"In the built app you will confirm the quantity before it is saved. Nothing is saved in this sample.","actions":[{"id":"back","label":"Change entry","to":"entry"}]}]}. At most eight screens, six text fields and four actions per screen; all destinations must exist and be reachable. Never include HTML, scripts, URLs, requests, expressions, integration claims or real user data. Keep the same approved capabilities and visual theme.';
const Fence = /^(`{3,}|~{3,})[ \t]*caddie-prototype[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/gm;
export function splitDesignPrototype(body: string): { display: string; prototype: DesignPrototype | null; error: string | null } {
 const matches = [...body.matchAll(Fence)];
 if (!matches.length) return { display: body, prototype: null, error: null };
 const display = body.replace(Fence, '').replace(/\n{3,}/g, '\n\n').trim();
 if (matches.length !== 1 || matches[0]![2]!.length > 24_000) return { display, prototype: null, error: 'Use one sample journey of at most 24,000 characters.' };
 let raw: unknown;
 try { raw = JSON.parse(matches[0]![2]!); } catch { return { display, prototype: null, error: 'The sample journey must be valid JSON.' }; }
 const parsed = v.safeParse(DesignPrototypeSchema, raw);
 if (!parsed.success) return { display, prototype: null, error: parsed.issues.map(issue => `${issue.path?.map(part => part.key).join('.') ?? 'journey'}: ${issue.message}`).join('; ') };
 const prototype = parsed.output;
 const screens = new Map(prototype.screens.map(screen => [screen.id, screen]));
 if (screens.size !== prototype.screens.length || !screens.has(prototype.start)) return { display, prototype: null, error: 'Screens need unique IDs and an existing starting screen.' };
 for (const screen of prototype.screens) {
  if (new Set(screen.fields.map(field => field.id)).size !== screen.fields.length || new Set(screen.actions.map(action => action.id)).size !== screen.actions.length || screen.actions.some(action => !screens.has(action.to))) return { display, prototype: null, error: 'Field and action IDs must be unique within a screen; action destinations must exist.' };
 }
 const reachable = new Set<string>();
 const visit = (id: string) => { if (reachable.has(id)) return; reachable.add(id); for (const action of screens.get(id)!.actions) visit(action.to); };
 visit(prototype.start);
 if (reachable.size !== screens.size) return { display, prototype: null, error: 'Every screen must be reachable from the starting screen.' };
 return { display, prototype, error: null };
}
