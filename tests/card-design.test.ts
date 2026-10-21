import { expect, test } from 'bun:test';
import type { DecisionCard } from '@caddie/contracts';
import { cardDesign } from '../apps/app/src/client/brief/card-design.ts';
import { briefActionRoute } from '../apps/app/src/client/brief/navigate.ts';
const card: DecisionCard = { id:'brf_approval_a', projectId:'project/a', kind:'approval', headline:'A plan', summary:'Original scope', evidenceIds:[], status:'needs-you', updatedAt:'2026-10-21T00:00:00.000Z', primaryAction:{ kind:'review', label:'Review plan', targetId:'a' } };
test('all seven approved designs use identity and typed state, not display copy', () => {
 expect(cardDesign(card)).toBe('plan');
 expect(cardDesign({...card,id:'brf_workflow_build_r',kind:'result',status:'changed'})).toBe('build');
 expect(cardDesign({...card,id:'brf_workflow_repair_r',kind:'result',status:'changed'})).toBe('repair');
 expect(cardDesign({...card,kind:'result',status:'handled',primaryAction:{kind:'preview',label:'Try',targetId:'output-2'}})).toBe('preview');
 expect(cardDesign({...card,kind:'deadline',status:'handled'})).toBe('deadline');
 expect(cardDesign({...card,id:'brf_opportunity_o',kind:'result',status:'handled'})).toBe('opportunity');
 expect(cardDesign({...card,status:'handled'})).toBe('earlier');
 expect(cardDesign({...card,id:'x',kind:'result',headline:'Repairing the preview right now',status:'blocked'})).toBe('update');
});
test('preview destinations preserve exact target and source; historical approval preserves decision id', () => {
 expect(briefActionRoute({...card,id:'brf_workflow_preview_output-2',primaryAction:{kind:'preview',label:'Try',targetId:'output-2'}})).toEqual({to:'/preview',search:{project:'project/a',preview:'output-2',source:'workflow'}});
 expect(briefActionRoute({...card,id:'brf_preview_share',primaryAction:{kind:'preview',label:'View',targetId:'share-1'}})).toEqual({to:'/preview',search:{project:'project/a',preview:'share-1',source:'share'}});
 expect(briefActionRoute({...card,status:'handled'}).search.approval).toBe('a');
 expect(briefActionRoute({...card,id:'brf_workflow_repair_r',primaryAction:{kind:'inspect',label:'Activity',targetId:'r'}}).to).toBe('/runs');
});
