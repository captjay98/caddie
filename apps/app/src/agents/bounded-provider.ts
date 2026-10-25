import type { ProviderStreams, StreamOptions, SimpleStreamOptions } from '@earendil-works/pi-ai';
import { DEADLINE_POLICY } from '../server/build-deadlines.ts';

/** Bounds the ACTUAL provider request and response body. SDK retries are disabled:
 * every Flue turn is one physical call and has one reservation/usage receipt.
 * Parent cancellation is inherited; response chunks reset idle time, never the hard deadline.
 */
export function boundedProvider(base: ProviderStreams, policy: { requestMs: number; streamIdleMs: number } = DEADLINE_POLICY): ProviderStreams {
  const wrap = <T extends StreamOptions>(options: T | undefined) => {
    const controller = new AbortController();
    const parent = options?.signal;
    const cancel = () => controller.abort(parent?.reason);
    parent?.addEventListener('abort', cancel, { once: true });
    if (parent?.aborted) cancel();
    const hard = setTimeout(() => controller.abort(new Error('MODEL_REQUEST_DEADLINE')), policy.requestMs);
    let idle: ReturnType<typeof setTimeout> | undefined;
    let cancelBody: (() => void) | undefined;
    const cleanup = () => { clearTimeout(hard); clearTimeout(idle); parent?.removeEventListener('abort', cancel); if (cancelBody) controller.signal.removeEventListener('abort', cancelBody); };
    const resetIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(() => controller.abort(new Error('MODEL_STREAM_IDLE')), policy.streamIdleMs);
    };
    const fetcher = options?.fetch ?? globalThis.fetch;
    const guardedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      controller.signal.throwIfAborted();
      const response = await fetcher(input, { ...init, signal: controller.signal });
      if (!response.body) return response;
      const reader = response.body.getReader();
      cancelBody = () => { void reader.cancel(controller.signal.reason).catch(() => {}); };
      controller.signal.addEventListener('abort', cancelBody, { once: true });
      resetIdle();
      const body = new ReadableStream<Uint8Array>({
        async pull(output) {
          try {
            const chunk = await reader.read();
            if (chunk.done) { clearTimeout(idle); output.close(); return; }
            resetIdle(); output.enqueue(chunk.value);
          } catch (error) { clearTimeout(idle); output.error(error); }
        },
        async cancel(reason) { clearTimeout(idle); await reader.cancel(reason); },
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    }) as NonNullable<StreamOptions['fetch']>;
    return { options: { ...options, signal: controller.signal, timeoutMs: Math.min(options?.timeoutMs ?? policy.requestMs, policy.requestMs), maxRetries: 0, fetch: guardedFetch } as T, cleanup };
  };
  return {
    stream(model, context, options) {
      const bounded = wrap(options);
      try { const stream = base.stream(model, context, bounded.options); void stream.result().then(bounded.cleanup, bounded.cleanup); return stream; }
      catch (error) { bounded.cleanup(); throw error; }
    },
    streamSimple(model, context, options) {
      const bounded = wrap<SimpleStreamOptions>(options);
      try { const stream = base.streamSimple(model, context, bounded.options); void stream.result().then(bounded.cleanup, bounded.cleanup); return stream; }
      catch (error) { bounded.cleanup(); throw error; }
    },
  };
}
