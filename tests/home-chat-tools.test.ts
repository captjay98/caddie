import { describe, expect, test } from 'bun:test';
import { makeCreateProject, makeListStacks } from '../apps/app/src/agents/tools';
import { STACK_CATALOG } from '../apps/app/src/server/stacks';

/**
 * The home-conversation chat-first tools (product charter: the chat is the
 * universal interface). Unit level — the tools delegate to injected host
 * closures; the app.ts home branch wires the same permission-checked project
 * service the REST route uses, and list_stacks serves the shared stack
 * registry. No model calls here (live round-trips are tests/live, BLOCKED
 * without credentials).
 */

describe('home chat tools', () => {
	test('create_project delegates to the host service and reports the created project', async () => {
		const created: Array<{ name: string; description?: string }> = [];
		const tool = makeCreateProject({
			createProject: async (input) => {
				created.push(input);
				return { id: 'proj_new1', name: input.name, workspaceId: 'ws_home' };
			},
		});
		const result = (await (tool as unknown as { run: (ctx: { data: unknown }) => Promise<{ output: string }> }).run({
			data: { name: '  todoer  ', description: ' a todo app ' },
		})) as { output: string };
		expect(created).toHaveLength(1);
		expect(created[0]).toEqual({ name: 'todoer', description: 'a todo app' });
		expect(result.output).toContain('todoer');
		expect(result.output).toContain('proj_new1');
		expect(result.output).toContain('workspace ws_home');
	});

	test('create_project omits an empty description instead of passing a blank', async () => {
		const created: Array<{ name: string; description?: string }> = [];
		const tool = makeCreateProject({
			createProject: async (input) => {
				created.push(input);
				return { id: 'proj_new2', name: input.name, workspaceId: 'ws_home' };
			},
		});
		await (tool as unknown as { run: (ctx: { data: unknown }) => Promise<unknown> }).run({
			data: { name: 'clean' },
		});
		expect(created).toEqual([{ name: 'clean' }]);
	});

	test('list_stacks serves the shared registry verbatim — never invention', async () => {
		const tool = makeListStacks({ listStacks: async () => STACK_CATALOG });
		const result = (await (tool as unknown as { run: (ctx: { data: unknown }) => Promise<{ output: string }> }).run({
			data: {},
		})) as { output: string };
		for (const entry of STACK_CATALOG) {
			expect(result.output).toContain(entry.id);
			expect(result.output).toContain(entry.status);
		}
		expect(result.output).toContain('react-hono — enabled');
	});
});
