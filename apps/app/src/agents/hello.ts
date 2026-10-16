'use agent';
import { useModel } from '@flue/runtime';
import { findModelRouteForRole } from './providers.ts';

// Scaffold agent from the pinned Flue cloudflare shape (generator 2.2.2).
// Product specialists arrive in P05; this agent proves the DO wiring.
//
// Model: the deployment registers ONLY the Nebius provider
// (registerNebiusProvider in app.ts), so a hardcoded 'anthropic/…' id would
// fail to resolve at runtime. Use the registered cheap `helper` route — this
// agent only ever proves the DO + router are wired, never does real work.
export function Hello() {
	useModel(findModelRouteForRole('helper').specifier);
	return 'You are a helpful assistant. Keep replies short.';
}
