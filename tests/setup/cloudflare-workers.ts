// Test-only: Bun has no `cloudflare:workers` built-in, but the Worker entry
// (apps/app/src/cloudflare.ts) exports Caddie's Durable Object and RPC
// entrypoint classes, which extend that module's base classes. This stand-in
// lets Bun tests import the entry; the real classes run only under workerd
// (tests/preview-runtime.integration.test.ts covers them there).
import { mock } from 'bun:test';

mock.module('cloudflare:workers', () => {
	class DurableObject {
		protected readonly ctx: unknown;
		protected readonly env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	}
	class WorkerEntrypoint {
		protected readonly ctx: unknown;
		protected readonly env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	}
	return { DurableObject, WorkerEntrypoint };
});
