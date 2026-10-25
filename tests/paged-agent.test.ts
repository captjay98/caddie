import {test,expect} from 'bun:test';
import {pagedAgentClient,mergeHistory} from '../apps/app/src/client/conversation/paged-agent.ts';
import type {createFlueClient,FlueConversationMessage} from '@flue/sdk';
test('native bounded observation retains cursor and all other client operations',()=>{
 let options:unknown; let construction:unknown;
 const send=()=>{};
 const fake=((input:unknown)=>{construction=input;return {send,observe:(input:unknown)=>{options=input;return{getSnapshot:()=>({conversation:{before:'opaque-cursor'}})}}}}) as unknown as typeof createFlueClient;
 const paged=pagedAgentClient('/agents/coordinator/project-conversation',fake);
 const observed=paged.client.observe({live:'sse'});
 observed.getSnapshot();
 expect(options).toEqual({live:'sse',limit:40});
 expect(construction).toEqual({url:'/agents/coordinator/project-conversation',headers:{'x-partykit-room':'project-conversation'}});
 expect(paged.cursor.current).toBe('opaque-cursor');
 expect(Object.is(paged.client.send,send)).toBe(true);
});
test('older cached pages cannot overwrite corrections in the live window',()=>{
 const message=(id:string,text:string)=>({id,role:'assistant',parts:[{type:'text',text,state:'done'}]}) as FlueConversationMessage;
 const merged=mergeHistory([message('old','Earlier'),message('same','old version')],[message('same','corrected'),message('new','Latest')]);
 expect(merged.map(m=>m.id)).toEqual(['old','same','new']);
 expect(merged[1]!.parts[0]).toMatchObject({text:'corrected'});
});
