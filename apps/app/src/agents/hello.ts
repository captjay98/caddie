'use agent';
import { useModel } from '@flue/runtime';

// Scaffold agent from the pinned Flue cloudflare shape (generator 2.2.2).
// Product specialists arrive in P05; this agent proves the DO wiring.
export function Hello() {
	useModel('anthropic/claude-haiku-4-5');
	return 'You are a helpful assistant. Keep replies short.';
}
