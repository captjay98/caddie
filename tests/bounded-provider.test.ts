import { expect, test } from 'bun:test';
import { boundedProvider } from '../apps/app/src/agents/bounded-provider.ts';
type ProviderStreams = Parameters<typeof boundedProvider>[0];
type StreamOptions = NonNullable<Parameters<ProviderStreams['stream']>[2]>;

function harness() {
 let options: StreamOptions | undefined;
 let finish!: () => void;
 const done = new Promise<void>(resolve => { finish=resolve; });
 const start = (_model: unknown, _context: unknown, supplied: StreamOptions) => {
  options=supplied;
  return { result: () => done };
 };
 const base={ stream:start,streamSimple:start } as unknown as ProviderStreams;
 return { base,options:()=>options!,finish };
}
test('both provider paths disable invisible retries and inherit cancellation',async()=>{
 for (const method of ['stream','streamSimple'] as const) {
  const h=harness();const controller=new AbortController();
  const guarded=boundedProvider(h.base,{requestMs:1000,streamIdleMs:1000});
  guarded[method]({} as never,{} as never,{signal:controller.signal,maxRetries:9});
  expect(h.options().maxRetries).toBe(0);
  controller.abort();expect(h.options().signal?.aborted).toBe(true);h.finish();
 }
});
test('the real response body is cancelled when it stops yielding chunks',async()=>{
 const h=harness();let cancelled=false;
 const response=new Response(new ReadableStream({ start(stream){stream.enqueue(new Uint8Array([1]));},cancel(){cancelled=true;} }));
 const guarded=boundedProvider(h.base,{requestMs:1000,streamIdleMs:10});
 guarded.stream({} as never,{} as never,{fetch:(async()=>response) as unknown as typeof fetch});
 const res=await h.options().fetch!('https://unused.invalid');
 const reader=res.body!.getReader();await reader.read();
 await new Promise(resolve=>setTimeout(resolve,40));
 expect(h.options().signal?.aborted).toBe(true);expect(cancelled).toBe(true);
 await reader.cancel();h.finish();
});
test('request deadline aborts even when the response has no body',async()=>{
 const h=harness();const guarded=boundedProvider(h.base,{requestMs:10,streamIdleMs:1000});
 guarded.stream({} as never,{} as never,{fetch:(async()=>new Response(null,{status:204})) as unknown as typeof fetch});
 await h.options().fetch!('https://unused.invalid');
 await new Promise(resolve=>setTimeout(resolve,40));
 expect(h.options().signal?.aborted).toBe(true);h.finish();
});
// FarmLog AI planning, 2026-10-29: the plan author's second call failed in
// ~450ms with workerd's "Network connection lost." (a pooled connection the
// provider had already closed) and the whole plan turn died. A failure BEFORE
// any response means the provider never answered, so one fresh attempt is safe.
test('a connection dropped before any response is retried once',async()=>{
 const h=harness();let calls=0;
 const guarded=boundedProvider(h.base,{requestMs:1000,streamIdleMs:1000});
 guarded.stream({} as never,{} as never,{fetch:(async()=>{calls+=1;if(calls===1)throw new Error('Network connection lost.');return new Response(null,{status:200});}) as unknown as typeof fetch});
 const res=await h.options().fetch!('https://unused.invalid');
 expect(res.status).toBe(200);expect(calls).toBe(2);h.finish();
});
test('a second dropped connection, or a cancelled request, is not retried',async()=>{
 const h=harness();let calls=0;
 const guarded=boundedProvider(h.base,{requestMs:1000,streamIdleMs:1000});
 guarded.stream({} as never,{} as never,{fetch:(async()=>{calls+=1;throw new Error('Network connection lost.');}) as unknown as typeof fetch});
 await expect(h.options().fetch!('https://unused.invalid')).rejects.toThrow('Network connection lost.');
 expect(calls).toBe(2);h.finish();
 const c=harness();const controller=new AbortController();let cancelledCalls=0;
 boundedProvider(c.base,{requestMs:1000,streamIdleMs:1000}).stream({} as never,{} as never,{signal:controller.signal,fetch:(async()=>{cancelledCalls+=1;controller.abort();throw new Error('Network connection lost.');}) as unknown as typeof fetch});
 await expect(c.options().fetch!('https://unused.invalid')).rejects.toThrow();
 expect(cancelledCalls).toBe(1);c.finish();
});
test('a provider error response is never retried here',async()=>{
 const h=harness();let calls=0;
 const guarded=boundedProvider(h.base,{requestMs:1000,streamIdleMs:1000});
 guarded.stream({} as never,{} as never,{fetch:(async()=>{calls+=1;return new Response('busy',{status:503});}) as unknown as typeof fetch});
 const res=await h.options().fetch!('https://unused.invalid');
 expect(res.status).toBe(503);expect(calls).toBe(1);h.finish();
});
test('a connection dropped on the first read, before any answer byte, is retried once',async()=>{
 const h=harness();let calls=0;
 const guarded=boundedProvider(h.base,{requestMs:1000,streamIdleMs:1000});
 guarded.stream({} as never,{} as never,{fetch:(async()=>{calls+=1;
  if(calls===1)return new Response(new ReadableStream({pull(c){c.error(new Error('Network connection lost.'));}}));
  return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: ok\n\n'));c.close();}}));}) as unknown as typeof fetch});
 const res=await h.options().fetch!('https://unused.invalid');
 expect(await res.text()).toBe('data: ok\n\n');expect(calls).toBe(2);h.finish();
});
test('a connection dropped after the answer started is not retried',async()=>{
 const h=harness();let calls=0;
 const guarded=boundedProvider(h.base,{requestMs:1000,streamIdleMs:1000});
 guarded.stream({} as never,{} as never,{fetch:(async()=>{calls+=1;let sent=false;
  return new Response(new ReadableStream({pull(c){if(!sent){sent=true;c.enqueue(new Uint8Array([1]));return;}c.error(new Error('Network connection lost.'));}}));}) as unknown as typeof fetch});
 const res=await h.options().fetch!('https://unused.invalid');
 await expect(res.arrayBuffer()).rejects.toThrow('Network connection lost.');expect(calls).toBe(1);h.finish();
});
