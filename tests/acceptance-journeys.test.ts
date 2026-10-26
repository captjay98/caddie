import {expect,test} from 'bun:test';
import {parseAcceptanceJourneys} from '@caddie/contracts';
const criteria=[{featureId:'save',text:'The entry survives a restart'}];
function body(change:(value:any)=>void=()=>{}){const value={version:1,criteria:[{...criteria[0],steps:[{kind:'fill',label:'Observation',value:'{{marker}}'},{kind:'click',name:'Save'},{kind:'restart'},{kind:'expect',text:'{{marker}}'}]}],states:[{title:'Today',steps:[{kind:'open',path:'/'}]}]};change(value);return '```html-mock Today\n<main>Today</main>\n```\n```caddie-checks\n'+JSON.stringify(value)+'\n```';}
test('criteria and screen/state mappings are exact, versioned and executable without arbitrary code',()=>{
 expect(parseAcceptanceJourneys(body(),criteria).criteria).toHaveLength(1);
 expect(()=>parseAcceptanceJourneys(body(value=>value.criteria[0].text='easier check'),criteria)).toThrow('exact');
 expect(()=>parseAcceptanceJourneys(body(value=>value.states[0].title='Other'),criteria)).toThrow('navigation');
 expect(()=>parseAcceptanceJourneys(body(value=>value.criteria[0].steps=[{kind:'evaluate',code:'true'}]),criteria)).toThrow('invalid');
 expect(()=>parseAcceptanceJourneys(body(value=>value.states[0].steps=[{kind:'open',path:'//evil.test'}]),criteria)).toThrow('invalid');
});
