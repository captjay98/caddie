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
