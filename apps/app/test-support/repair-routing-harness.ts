/** Test-only real Flue loop: a delegate remains open over two checked failures. */
import {init,useModel,usePersistentState,useSubagent,useTool} from '@flue/runtime';
import {start} from '@flue/runtime/node';
import * as v from 'valibot';
import {scriptedProvider} from './scripted-provider.ts';
import {findModelRoute} from '../src/agents/providers.ts';
import {recordCheckedRepair,repairState} from '../src/server/repair-escalation.ts';
import {makeTaskDeadlineInstrumentation} from '../src/server/task-deadlines.ts';
import {instrument} from '@flue/runtime';
import type {D1Database} from '../src/server/auth.ts';
export async function checkLiveRepairRouting(db:D1Database,runId:string,admissionId:string) {
 let failures=0;const calls:string[]=[];
 function Leaf(){useTool({name:'checked_failure',description:'Records the failed host check',input:v.object({}),async run(){failures++;await recordCheckedRepair(db,{runId,admissionId,operationKey:`failure:${failures}`,issue:'f:checks',detail:'failed behavior check'});return {output:'failed'};}});return 'Repair this feature.';}
 function Parent(){const [route,setRoute]=usePersistentState('repair-route','minimax-m3.1-flash');useModel('scripted/nvidia/Nemotron-3.5-Super-VL');useSubagent({name:'builder',description:'Build',agent:Leaf,model:`scripted/${findModelRoute(route).modelId}`});useTool({name:'refresh',description:'Refresh host-selected model',input:v.object({}),async run(){const state=await repairState(db,runId);setRoute(state!.routeId!);return {output:'refreshed'};}});return 'Host-controlled repair.';}
 const provider=scriptedProvider({providerId:'scripted',routes:['minimax-m3.1-flash','deepseek-v4.1-flash-1017','nemotron-3.5-super-vl'].map(id=>{const route=findModelRoute(id);return {modelId:route.modelId,inputPerMtokUsd:0,outputPerMtokUsd:0,contextWindow:route.contextWindow,maxTokens:route.maxTokens};}),script:[
  {toolCall:{id:'first',name:'task',arguments:{agent:'builder',prompt:'repair'}},input:1,output:1},
  {toolCall:{id:'fail-1',name:'checked_failure',arguments:{}},input:1,output:1},
  {toolCall:{id:'fail-2',name:'checked_failure',arguments:{}},input:1,output:1},
  // The old delegate's next model call must be intercepted BEFORE transport.
  {toolCall:{id:'refresh',name:'refresh',arguments:{}},input:1,output:1},
  {toolCall:{id:'second',name:'task',arguments:{agent:'builder',prompt:'repair with the next route'}},input:1,output:1},
  {toolCall:{id:'fail-3',name:'checked_failure',arguments:{}},input:1,output:1},
  {toolCall:{id:'fail-4',name:'checked_failure',arguments:{}},input:1,output:1},
  {toolCall:{id:'refresh-third',name:'refresh',arguments:{}},input:1,output:1},
  {toolCall:{id:'third',name:'task',arguments:{agent:'builder',prompt:'repair with the third route'}},input:1,output:1},
  {text:'fixed with the final route',input:1,output:1},
  {text:'done',input:1,output:1},
 ]});
 const bounds=makeTaskDeadlineInstrumentation({resolve:()=>db});
 const dispose=instrument({observe(event,ctx){bounds.observe(event,ctx);if(event.type==='turn'&&!event.isError)calls.push(event.request.requestedModel);},dispose(){},interceptor:bounds.interceptor});
 const flue=await start({agents:[Parent],providers:[provider.provider]});
 try{const parent=init(Parent,{id:'live-repair-routing'});await parent.read(await parent.dispatch('go'));return {calls,failures,physicalCalls:provider.callCount()};}finally{await flue.stop();await dispose();}
}
