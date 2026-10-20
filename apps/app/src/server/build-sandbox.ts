import type { AuthEnv } from './auth.ts';
import { D1SandboxPersistence } from './adapters/sandbox-persistence.ts';
import { SandboxDriver } from './adapters/sandbox.ts';

/** The image every new working copy starts from, unless CONTREE_IMAGE says otherwise. */
export const DEFAULT_BASE_IMAGE = 'tag:tt-base:1';

/**
 * Flutter apps (Track 3) start from the Flutter image instead, unless
 * CONTREE_FLUTTER_IMAGE says otherwise: tag:tt-base:1 plus OpenJDK 17,
 * Flutter 3.44.8 and the Android SDK, with warm Gradle and pub caches. Built
 * 2026-10-19 by scripts/build-flutter-image.ts; untagged, so Contree may
 * delete it 180 days after creation (about 2027-04-17): re-run the script and
 * set CONTREE_FLUTTER_IMAGE before then.
 */
export const DEFAULT_FLUTTER_IMAGE = '1864960e-7449-4d26-ab77-9582989efc2e';

/**
 * tt-base installs Bun outside the non-login shell's default PATH. Only
 * runtime locations enter the sandbox, never the Worker's environment.
 */
export const BUILD_RUNTIME_ENV: Record<string, string> = {
	PATH: '/root/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin',
};

/**
 * The Flutter image's tools (scripts/build-flutter-image.ts RUN_ENV) plus Bun
 * for the app's server. HOME and PUB_CACHE point at the caches the image was
 * warmed with; the base image leaves HOME unset.
 */
export const FLUTTER_RUNTIME_ENV: Record<string, string> = {
	PATH: '/opt/flutter/bin:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
	HOME: '/root',
	JAVA_HOME: '/usr/lib/jvm/java-17-openjdk-amd64',
	ANDROID_HOME: '/opt/android-sdk',
	ANDROID_SDK_ROOT: '/opt/android-sdk',
	PUB_CACHE: '/root/.pub-cache',
	FLUTTER_SUPPRESS_ANALYTICS: 'true',
	CI: 'true',
};

/** The image and runtime environment a run's stack builds in. */
export function stackRuntime(stackId: string | undefined, env: { CONTREE_IMAGE?: string; CONTREE_FLUTTER_IMAGE?: string }): { image: string; env: Record<string, string> } {
	return stackId === 'flutter'
		? { image: env.CONTREE_FLUTTER_IMAGE || DEFAULT_FLUTTER_IMAGE, env: FLUTTER_RUNTIME_ENV }
		: { image: env.CONTREE_IMAGE ?? DEFAULT_BASE_IMAGE, env: BUILD_RUNTIME_ENV };
}

export interface BuildSandboxEnv {
	DB: AuthEnv['DB'];
	CONTREE_BASE_URL?: string;
	CONTREE_API_TOKEN?: string;
	CONTREE_PROJECT_ID?: string;
	CONTREE_IMAGE?: string;
	/** Flutter apps' image (Track 3); defaults to DEFAULT_FLUTTER_IMAGE. */
	CONTREE_FLUTTER_IMAGE?: string;
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
