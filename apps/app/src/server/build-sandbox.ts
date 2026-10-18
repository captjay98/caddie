import type { AuthEnv } from './auth.ts';
import { D1SandboxPersistence } from './adapters/sandbox-persistence.ts';
import { SandboxDriver } from './adapters/sandbox.ts';

/** The image every new working copy starts from, unless CONTREE_IMAGE says otherwise. */
export const DEFAULT_BASE_IMAGE = 'tag:tt-base:1';

/**
 * tt-base installs Bun outside the non-login shell's default PATH. Only
 * runtime locations enter the sandbox, never the Worker's environment.
 */
export const BUILD_RUNTIME_ENV: Record<string, string> = {
	PATH: '/root/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin',
};

export interface BuildSandboxEnv {
	DB: AuthEnv['DB'];
	CONTREE_BASE_URL?: string;
	CONTREE_API_TOKEN?: string;
	CONTREE_PROJECT_ID?: string;
	CONTREE_IMAGE?: string;
}

export function buildSandboxConfigured(env: BuildSandboxEnv): boolean {
	return Boolean(env.CONTREE_BASE_URL && env.CONTREE_API_TOKEN && env.CONTREE_PROJECT_ID);
}

/** The build sandbox with Caddie's quotas, or null when it is not configured. */
export function buildSandboxFromEnv(env: BuildSandboxEnv): SandboxDriver | null {
	if (!buildSandboxConfigured(env)) return null;
	return new SandboxDriver(
		{
			contree: {
				baseUrl: env.CONTREE_BASE_URL!,
				apiToken: env.CONTREE_API_TOKEN!,
				platformProjectId: env.CONTREE_PROJECT_ID!,
			},
			quotas: {
				maxCommandTimeoutMs: 15 * 60_000,
				maxOutputBytes: 5 * 1024 * 1024,
				maxUploadBytes: 20 * 1024 * 1024,
			},
			workspaceRoot: '/workspace',
		},
		new D1SandboxPersistence(env.DB),
	);
}
