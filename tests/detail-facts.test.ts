import { expect, test } from 'bun:test';
import { mergeDetailFacts } from '../apps/app/src/client/discovery/detail-facts.ts';

test('one Key details list keeps precise time, one prize/format and every structured field',()=>{
 const result=mergeDetailFacts([
  {key:'dates',label:'When',value:'Aug 31 – Oct 23'}, {key:'format',label:'Where',value:'Online'},
  {key:'prize',label:'Prize',value:'$138k'}, {key:'entries',label:'Entered',value:'59.8k'},
  {key:'themes',label:'Themes',value:'AI, Open Ended, Productivity'},
 ],'Oct 23',['Deadline → Oct 23, 2026 @ 12:00pm PDT','Prize pool → $138,000 in cash','Format → Online','Eligibility → Must be of legal age']);
 expect(result.facts.map(f=>f.label)).toEqual(['Event dates','Submission deadline','Format','Prize pool','Participants','Themes']);
 expect(result.facts[1]!.value).toBe('Oct 23, 2026 @ 12:00pm PDT');
 expect(result.facts[3]!.value).toBe('$138,000 in cash');
 expect(result.entryNotes[0]!.value).toBe('Must be of legal age');
 expect(result.facts.some(f=>f.key==='eligibility')).toBe(false);
});
test('missing digest uses listing facts and unknown fields are never invented',()=>{
 expect(mergeDetailFacts([],null,[])).toEqual({facts:[],notes:[],entryNotes:[]});
 expect(mergeDetailFacts([{key:'format',label:'Where',value:'Hybrid'}],'Oct 30',[]).facts.map(f=>f.value)).toEqual(['Oct 30','Hybrid']);
});
test('retains additional challenge notes and conflicting repeated bullet values',()=>{
 const result=mergeDetailFacts([],null,['Make a working demo','Team size → 1–4','Deadline → Oct 23','Deadline → Oct 24']);
 expect(result.notes).toEqual(['Make a working demo','Deadline → Oct 24']);
 expect(result.facts.find(f=>f.key==='team')?.value).toBe('1–4');
});
