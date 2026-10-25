import type { ChannelSource } from './channel-store.ts';
export interface DesignWorkStatus { kind:'loading'|'reconnecting'|'failed'|'quiet'|'active'|'waiting'; title:string; detail:string; }
/** A workflow phase is intent, not evidence that a model is currently running. */
export function designWorkStatus(input:{ source:ChannelSource; updatedAt:string; observedAt?:number; now:number }):DesignWorkStatus {
 const {source}=input;
 if(!source.historyReady) return {kind:'loading',title:'Checking design progress',detail:'Your saved plan and chosen look are retained.'};
 if(source.error || source.status==='connecting') return {kind:'reconnecting',title:'Reconnecting to Caddie',detail:'Progress is unavailable while the connection recovers. Your saved work is retained.'};
 const active=source.status==='streaming'||source.status==='submitted';
 const last=source.settlements.at(-1);
 const settlementAt=last?.timestamp ? Date.parse(last.timestamp) : NaN;
 const currentFailure=last && last.outcome!=='completed' && (!Number.isFinite(settlementAt)||settlementAt>=Date.parse(input.updatedAt));
 if(!active && currentFailure) return {kind:'failed',title:last.outcome==='aborted'?'Design was stopped':'The design could not be finished',detail:'Your approved plan and chosen look are safe. Retry the design, or discuss what to change with Caddie.'};
 const lastActivity=input.observedAt ?? Date.parse(input.updatedAt);
 if(active && Number.isFinite(lastActivity) && input.now-lastActivity>120_000) return {kind:'quiet',title:'No recent design activity',detail:'Caddie has not reported a new update recently. Ask for an update before assuming the design is still progressing.'};
 if(!active) return {kind:'waiting',title:'Waiting for design work',detail:'No design task is currently running. Your plan and chosen look are saved.'};
 const tools=source.messages.flatMap(message=>message.parts).filter(part=>part.type==='dynamic-tool');
 const latest=tools.at(-1);
 const name=latest && 'toolName' in latest ? latest.toolName : '';
 const detail=name==='read_project_context'?'Checking the approved plan and chosen look.':name==='write_plan_note'?'Preparing the design for review.':'Preparing screen layouts, key interactions and empty and error states.';
 return {kind:'active',title:'Designing your screens',detail};
}
