import type { MetaPart } from '../conversation/hackathon-format.ts';

export interface DetailFact { key: string; label: string; value: string }
const BULLET_KEYS: Readonly<Record<string, string>> = {
 deadline: 'deadline', 'submission deadline': 'deadline', 'submit by': 'deadline',
 prize: 'prize', 'prize pool': 'prize', 'total prize': 'prize', 'total prizes': 'prize',
 format: 'format', where: 'format', 'team size': 'team', team: 'team', eligibility: 'eligibility',
};

/** Presentation only: keep the full sourced wording; never infer a date or an entry verdict. */
export function mergeDetailFacts(parts: readonly MetaPart[], deadline: string | null | undefined, bullets: readonly string[]): {
 facts: DetailFact[]; notes: string[]; entryNotes: DetailFact[];
} {
 const extra = new Map<string, DetailFact>();
 const notes: string[] = [];
 const entryNotes: DetailFact[] = [];
 for (const bullet of bullets) {
  const split = bullet.indexOf(' → ');
  if (split < 0) { notes.push(bullet); continue; }
  const label = bullet.slice(0, split).trim(), value = bullet.slice(split + 3).trim();
  if (!label || !value) { notes.push(bullet); continue; }
  const key = BULLET_KEYS[label.toLowerCase()] ?? label.toLowerCase();
  if (key === 'eligibility') { entryNotes.push({key,label:'Entry conditions',value}); continue; }
  // Keep conflicting repeated source values visible instead of silently replacing them.
  const previous = extra.get(key);
  if (previous && previous.value !== value) { notes.push(bullet); continue; }
  extra.set(key,{key,label,value});
 }
 const byKey = new Map(parts.map(part => [part.key,part]));
 const facts: DetailFact[] = [];
 const add = (key:string,label:string,value:string|undefined|null) => { if(value) facts.push({key,label,value}); extra.delete(key); };
 add('dates','Event dates',byKey.get('dates')?.value);
 add('deadline','Submission deadline',extra.get('deadline')?.value ?? deadline);
 add('format','Format',byKey.get('format')?.value ?? extra.get('format')?.value);
 add('prize','Prize pool',extra.get('prize')?.value ?? byKey.get('prize')?.value);
 add('entries','Participants',byKey.get('entries')?.value);
 add('themes','Themes',byKey.get('themes')?.value);
 facts.push(...extra.values());
 return {facts,notes,entryNotes};
}
