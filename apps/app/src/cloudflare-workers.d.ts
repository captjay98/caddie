// Minimal ambient types for the `cloudflare:workers` built-in module — only
// what Caddie's own Durable Objects and RPC entrypoints use. The full
// @cloudflare/workers-types package is deliberately not a dependency.
declare module 'cloudflare:workers' {
	export interface DurableObjectStateLike {
		readonly storage: {
			readonly sql: {
				exec(query: string, ...bindings: unknown[]): {
					toArray(): Record<string, unknown>[];
					raw(): Iterable<unknown[]>;
					readonly columnNames: string[];
					readonly rowsRead: number;
					readonly rowsWritten: number;
				};
			};
			transactionSync<T>(closure: () => T): T;
			deleteAll(): Promise<void>;
		};
	}

	export abstract class DurableObject<Env = unknown> {
		protected readonly ctx: DurableObjectStateLike;
		protected readonly env: Env;
		constructor(ctx: DurableObjectStateLike, env: Env);
	}

	export abstract class WorkerEntrypoint<Env = unknown, Props = unknown> {
		protected readonly ctx: { readonly props: Props; waitUntil(promise: Promise<unknown>): void };
		protected readonly env: Env;
		constructor(ctx: unknown, env: Env);
	}
}
