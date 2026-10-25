#!/usr/bin/env bun
/**
 * Thinking-level probe (owner 2026-10-25: "build thinking levels").
 *
 *   CADDIE_LIVE_AUTHORIZED=1 bun scripts/probe-thinking.ts
 *
 * One tiny chat completion per (route, effort) pair — `reasoning_effort` in
 * the OpenAI-completions body, exactly as the pi-ai adapter sends it — plus a
 * zai-format variant for GLM. Records HTTP status, latency and usage only
 * (never the key, never a response body). Budget: 7 completions, max_tokens
 * 128, trivially under $0.01.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASE_URL = 'https://api.tokenfactory.nebius.com/v1';

if (process.env.CADDIE_LIVE_AUTHORIZED !== '1') {
	console.error('probe-thinking: BLOCKED — set CADDIE_LIVE_AUTHORIZED=1 (owner-approved live budget).');
	process.exit(1);
}
{
	const devVarsPath = join(REPO_ROOT, '.dev.vars');
	if (existsSync(devVarsPath)) {
		for (const line of readFileSync(devVarsPath, 'utf8').split('\n')) {
			const match = /^([A-Z_a-z][A-Z0-9_a-z]*)=(.*)$/.exec(line);
			if (match && process.env[match[1]] === undefined && match[2].trim() !== '') {
				process.env[match[1]] = match[2];
			}
		}
	}
}
const API_KEY = process.env.NEBIUS_API_KEY?.trim() ?? '';
if (!API_KEY) { console.error('probe-thinking: BLOCKED — NEBIUS_API_KEY missing.'); process.exit(1); }

const ROUTES: Array<{ label: string; model: string; effort: string; extra?: Record<string, unknown> }> = [
	{ label: 'chat    super-vl  low', model: 'nvidia/Nemotron-3.5-Super-VL', effort: 'low' },
	{ label: 'ideate  ultra     high', model: 'nvidia/Nemotron-3-Ultra-550b-a55b', effort: 'high' },
	{ label: 'plan    glm       high (reasoning_effort)', model: 'zai-org/GLM-5.3-Flash', effort: 'high' },
	{ label: 'plan    glm       high (zai thinking)', model: 'zai-org/GLM-5.3-Flash', effort: 'high', extra: { thinking: { type: 'enabled' } } },
	{ label: 'build   super-vl  medium', model: 'nvidia/Nemotron-3.5-Super-VL', effort: 'medium' },
	{ label: 'helper  nano      low', model: 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B', effort: 'low' },
	{ label: 'app     lightning low', model: 'nvidia/Nemotron-3_5-Lightning', effort: 'low' },
];

for (const route of ROUTES) {
	const started = Date.now();
	try {
		const res = await fetch(`${BASE_URL}/chat/completions`, {
			method: 'POST',
			headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
			body: JSON.stringify({
				model: route.model,
				messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
				max_tokens: 128,
				reasoning_effort: route.effort,
				...route.extra,
			}),
		});
		const ms = Date.now() - started;
		if (!res.ok) {
			const text = await res.text();
			console.log(`${route.label}: HTTP ${res.status} (${ms}ms) — ${text.slice(0, 140)}`);
			continue;
		}
		const body = await res.json() as { usage?: { completion_tokens?: number }; choices?: Array<{ message?: { reasoning_content?: unknown; content?: string } }> };
		const message = body.choices?.[0]?.message;
		console.log(`${route.label}: HTTP 200 (${ms}ms) tokens=${body.usage?.completion_tokens ?? '?'} content=${JSON.stringify((message?.content ?? '').slice(0, 24))} reasoning_content=${message?.reasoning_content ? 'yes' : 'no'}`);
	} catch (error) {
		console.log(`${route.label}: ERROR ${String(error).slice(0, 120)}`);
	}
}
