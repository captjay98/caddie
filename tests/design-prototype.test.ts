import { expect, test } from 'bun:test';
import { splitDesignPrototype } from '@caddie/contracts';
const valid = { title: 'Record feed', reason: 'Try the confirmation step', start: 'entry', screens: [
 { id: 'entry', title: 'Feed today', body: 'Enter a sample quantity.', fields: [{id: 'quantity', label: 'Feed quantity'}], actions: [{id: 'next', label: 'Review', to: 'review'}] },
 { id: 'review', title: 'Check the entry', body: 'Nothing is saved in this sample.', actions: [{id: 'back', label: 'Change', to: 'entry'}] },
] };
const body = (value: unknown) => 'Your design.\n```caddie-prototype\n' + JSON.stringify(value) + '\n```';
test('optional bounded journeys retain prose and validate reachable actions', () => {
 expect(splitDesignPrototype('Older saved design.')).toEqual({ display:'Older saved design.', prototype:null,error:null });
 const parsed = splitDesignPrototype(body(valid));
 expect(parsed.error).toBeNull(); expect(parsed.prototype?.screens).toHaveLength(2); expect(parsed.display).toBe('Your design.');
});
test('unsafe capabilities and broken state machines cannot be saved', () => {
 for (const value of [{...valid, script:'fetch("/api/delete")'}, {...valid, start:'missing'}, {...valid, screens:[...valid.screens, {...valid.screens[1], id:'unreachable'}]}, {...valid, screens:[valid.screens[0], {...valid.screens[1], actions:[{id:'next',label:'Exit',to:'missing'}]}]}]) expect(splitDesignPrototype(body(value)).error).toBeTruthy();
 expect(splitDesignPrototype(body(valid)+'\n'+body(valid)).error).toBeTruthy();
});
