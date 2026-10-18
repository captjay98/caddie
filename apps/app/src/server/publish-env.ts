import { CloudflareAppHost, readCloudflareConfig, type CloudflareEnv } from './adapters/cloudflare.ts';
import { AppHostError } from './app-host.ts';
import type { OperatorNotifier } from './abuse-reports.ts';
import { mailerFromEnv } from './notifications.ts';
import type { PublishDeps } from './publish.ts';
import { SecretBoxError, keyringFromEnv, type Keyring } from './secret-box.ts';

/**
 * Publishing's runtime wiring, shared by the HTTP routes and the 5-minute
 * cron (safety-check sweep, daily recheck). Returns null unless every owner
 * input is present: the Cloudflare account values and a valid APPS_DOMAIN.
 */

export type PublishEnv = Partial<CloudflareEnv> & {
	APPS_DOMAIN?: string;
	APP_SECRETS_KEYS?: string;
	/** The monitored abuse inbox (owner input); new reports and takedowns are emailed here. */
	ABUSE_INBOX?: string;
	RESEND_API_KEY?: string;
	RESEND_FROM?: string;
};

const APPS_DOMAIN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function appsDomainOf(env: PublishEnv): string | null {
	const domain = (env.APPS_DOMAIN ?? '').trim().toLowerCase().replace(/\.+$/, '');
	return APPS_DOMAIN.test(domain) ? domain : null;
}

async function keyringOrNull(env: PublishEnv): Promise<Keyring | null> {
	if (!(env.APP_SECRETS_KEYS ?? '').trim()) return null;
	try {
		return await keyringFromEnv(env);
	} catch (error) {
		if (error instanceof SecretBoxError) {
			console.error('publish: APP_SECRETS_KEYS unusable:', error.code);
			return null;
		}
		throw error;
	}
}

/** GET a live URL from Caddie's Worker; the status, or 0 when nothing answered. */
async function probe(url: string): Promise<number> {
	try {
		const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { 'user-agent': 'Caddie publish check' } });
		await response.body?.cancel().catch(() => undefined);
		return response.status;
	} catch {
		return 0;
	}
}

/** Email the operator's abuse inbox; false when no inbox or no mail provider is configured. */
export function operatorNotifierFromEnv(env: PublishEnv): OperatorNotifier {
	return async (subject, text) => {
		const to = (env.ABUSE_INBOX ?? '').trim();
		if (!to) return false;
		const result = await mailerFromEnv(env as Record<string, unknown>).send({ to, subject, textBody: text });
		if (!result.ok) console.error('abuse inbox: email not sent:', result.error);
		return result.ok;
	};
}

export async function publishDepsFromEnv(env: PublishEnv): Promise<PublishDeps | null> {
	const appsDomain = appsDomainOf(env);
	if (!appsDomain) return null;
	let host: CloudflareAppHost;
	try {
		host = new CloudflareAppHost(readCloudflareConfig(env));
	} catch (error) {
		if (error instanceof AppHostError && error.code === 'NOT_CONFIGURED') return null;
		throw error;
	}
	return { host, appsDomain, keyring: await keyringOrNull(env), probe, notifyOperator: operatorNotifierFromEnv(env) };
}
