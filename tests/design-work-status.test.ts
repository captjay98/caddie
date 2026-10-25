import {test,expect} from 'bun:test';
import {designWorkStatus} from '../apps/app/src/client/conversation/design-work-status.ts';
import {standbySource} from '../apps/app/src/client/conversation/channel-store.ts';
const now=Date.parse('2026-10-25T01:00:00Z');
const updatedAt='2026-10-25T00:00:00Z';
test('design intent never disguises a failed or absent task as active',()=>{
 expect(designWorkStatus({source:standbySource,updatedAt,now}).kind).toBe('waiting');
 expect(designWorkStatus({source:{...standbySource,settlements:[{submissionId:'s',outcome:'failed',timestamp:'2026-10-25T00:30:00Z'}]},updatedAt,now}).kind).toBe('failed');
 expect(designWorkStatus({source:{...standbySource,settlements:[{submissionId:'old',outcome:'failed',timestamp:'2026-10-24T00:30:00Z'}]},updatedAt,now}).kind).toBe('waiting');
});
test('quiet work and lost connections are visible without inventing progress',()=>{
 expect(designWorkStatus({source:{...standbySource,status:'streaming'},updatedAt,now}).kind).toBe('quiet');
 expect(designWorkStatus({source:{...standbySource,status:'streaming'},updatedAt,observedAt:now-5000,now}).kind).toBe('active');
 expect(designWorkStatus({source:{...standbySource,status:'connecting'},updatedAt,now}).kind).toBe('reconnecting');
 expect(designWorkStatus({source:{...standbySource,historyReady:false},updatedAt,now}).kind).toBe('loading');
});
