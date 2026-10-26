import {AsyncLocalStorage} from 'node:async_hooks';
export interface BuildTaskDeadline {signal:AbortSignal;deadlineAt:number;admissionId:string;runId?:string;repairRouteId?:string|null;featureIds?:readonly string[];moduleInstance?:string;}
export const buildTaskDeadlines=new AsyncLocalStorage<BuildTaskDeadline>();
export const currentBuildTask=()=>buildTaskDeadlines.getStore();
export function effectiveBuildSignal(signal?:AbortSignal):AbortSignal|undefined {
 const task=currentBuildTask();
 return task?AbortSignal.any([...(signal?[signal]:[]),task.signal]):signal;
}
