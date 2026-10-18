import type { D1Database } from './auth.ts';
import { ScopeError } from './scope.ts';

/**
 * Abuse reports (migration 0029): from the "Report" link on every published
 * app (visitors), and the ones Caddie files itself when a safety check flags
 * an app. Every new report is emailed to the operator's abuse inbox when one
 * is configured — Cloudflare expects platforms to answer abuse reports within
 * 24 hours.
 */

export type AbuseCategory = 'phishing' | 'malware' | 'scam' | 'illegal' | 'other';
export type AbuseSource = 'visitor' | 'url-scan' | 'web-risk' | 'operator';
export const ABUSE_CATEGORIES: readonly AbuseCategory[] = ['phishing', 'malware', 'scam', 'illegal', 'other'];

export const REPORT_DETAILS_MAX = 2000;
export const REPORTS_PER_HOUR = 5;

/** Send one message to the operator's abuse inbox; resolves false when there is none. */
export type OperatorNotifier = (subject: string, text: string) => Promise<boolean>;

export interface AbuseReportView {
	id: string;
	slug: string;
	projectId: string | null;
	source: AbuseSource;
	category: AbuseCategory;
	details: string;
	reporterEmail: string | null;
	status: 'open' | 'actioned' | 'dismissed';
	createdAt: string;
	resolvedAt: string | null;
	resolution: string | null;
	app: { status: string; blockedReason: string | null } | null;
}

type Row = Record<string, unknown>;

async function all(db: D1Database, sql: string, ...params: unknown[]): Promise<Row[]> {
	return (await db.prepare(sql).bind(...params).all<Row>()).results ?? [];
}

const EMAIL = /^[^\s@<>]{1,64}@[^\s@<>]{1,190}\.[^\s@<>]{2,24}$/;

export async function fileAbuseReport(
	db: D1Database,
	input: {
		slug: unknown;
		source: AbuseSource;
		category: unknown;
		details: unknown;
		reporterEmail?: unknown;
		reporterHash?: string | null;
		now?: string;
	},
	notify?: OperatorNotifier,
): Promise<{ id: string; projectId: string | null }> {
	const slug = typeof input.slug === 'string' ? input.slug.trim().toLowerCase().slice(0, 64) : '';
	if (!/^[a-z0-9-]{1,64}$/.test(slug)) throw new ScopeError(400, 'invalid_input', 'Say which app you are reporting.');
	const category = typeof input.category === 'string' && (ABUSE_CATEGORIES as readonly string[]).includes(input.category) ? (input.category as AbuseCategory) : null;
	if (!category) throw new ScopeError(400, 'invalid_input', 'Pick what is wrong with the app.');
	const details = typeof input.details === 'string' ? input.details.trim().slice(0, REPORT_DETAILS_MAX) : '';
	if (details.length < 3) throw new ScopeError(400, 'invalid_input', 'Tell us a little about what you saw.');
	const rawEmail = typeof input.reporterEmail === 'string' ? input.reporterEmail.trim() : '';
	const reporterEmail = rawEmail && EMAIL.test(rawEmail) ? rawEmail : null;
	if (rawEmail && !reporterEmail) throw new ScopeError(400, 'invalid_input', "That email address doesn't look right. You can also leave it empty.");
	const now = input.now ?? new Date().toISOString();

	if (input.source === 'visitor' && input.reporterHash) {
		const since = new Date(Date.parse(now) - 60 * 60_000).toISOString();
		const recent = await all(db, 'select count(*) as "n" from "abuse_reports" where "reporterHash" = ? and "createdAt" >= ?', input.reporterHash, since);
		if (Number(recent[0]?.['n'] ?? 0) >= REPORTS_PER_HOUR) {
			throw new ScopeError(429, 'too_many_reports', 'You have sent several reports already. Try again in an hour.');
		}
	}

	const app = (await all(db, 'select "projectId" from "app_publications" where "slug" = ?', slug))[0];
	const projectId = app ? String(app['projectId']) : null;
	const id = `rep_${crypto.randomUUID()}`;
	await db
		.prepare(
			'insert into "abuse_reports" ("id","slug","projectId","source","category","details","reporterEmail","reporterHash","status","notified","createdAt") values (?,?,?,?,?,?,?,?,\'open\',0,?)',
		)
		.bind(id, slug, projectId, input.source, category, details, reporterEmail, input.reporterHash ?? null, now)
		.run();

	if (notify) {
		const subject = `[Caddie abuse] ${category} report for ${slug}${input.source === 'visitor' ? '' : ` (${input.source})`}`;
		const text = [
			`App: ${slug}${projectId ? ` (project ${projectId})` : ' (no published app has this address)'}`,
			`Source: ${input.source}`,
			`Category: ${category}`,
			reporterEmail ? `Reporter: ${reporterEmail}` : 'Reporter: anonymous',
			'',
			details,
			'',
			'Answer within 24 hours. Review it in Caddie: /app/operator/reports',
		].join('\n');
		try {
			if (await notify(subject, text)) await db.prepare('update "abuse_reports" set "notified" = 1 where "id" = ?').bind(id).run();
		} catch (error) {
			console.error('abuse report: notifying the operator failed:', error instanceof Error ? error.message : error);
		}
	}
	return { id, projectId };
}

export async function listAbuseReports(db: D1Database, options: { status?: 'open' | 'actioned' | 'dismissed'; limit?: number } = {}): Promise<AbuseReportView[]> {
	const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
	const rows = options.status
		? await all(
				db,
				'select r.*, p."status" as "appStatus", p."blockedReason" as "appBlockedReason" from "abuse_reports" r left join "app_publications" p on p."projectId" = r."projectId" where r."status" = ? order by r."createdAt" desc limit ?',
				options.status,
				limit,
			)
		: await all(
				db,
				'select r.*, p."status" as "appStatus", p."blockedReason" as "appBlockedReason" from "abuse_reports" r left join "app_publications" p on p."projectId" = r."projectId" order by r."createdAt" desc limit ?',
				limit,
			);
	return rows.map((row) => ({
		id: String(row['id']),
		slug: String(row['slug']),
		projectId: (row['projectId'] as string | null) ?? null,
		source: row['source'] as AbuseSource,
		category: row['category'] as AbuseCategory,
		details: String(row['details']),
		reporterEmail: (row['reporterEmail'] as string | null) ?? null,
		status: row['status'] as AbuseReportView['status'],
		createdAt: String(row['createdAt']),
		resolvedAt: (row['resolvedAt'] as string | null) ?? null,
		resolution: (row['resolution'] as string | null) ?? null,
		app: row['appStatus'] ? { status: String(row['appStatus']), blockedReason: (row['appBlockedReason'] as string | null) ?? null } : null,
	}));
}

export async function resolveAbuseReport(
	db: D1Database,
	id: string,
	input: { status: unknown; note?: unknown; by: string; now?: string },
): Promise<void> {
	const status = input.status === 'actioned' || input.status === 'dismissed' ? input.status : null;
	if (!status) throw new ScopeError(400, 'invalid_input', "status must be 'actioned' or 'dismissed'");
	const note = typeof input.note === 'string' ? input.note.trim().slice(0, 500) : null;
	const result = await db
		.prepare('update "abuse_reports" set "status" = ?, "resolution" = ?, "resolvedBy" = ?, "resolvedAt" = ? where "id" = ?')
		.bind(status, note, input.by, input.now ?? new Date().toISOString(), id)
		.run();
	if (Number((result as { meta?: { changes?: number } }).meta?.changes ?? 0) === 0) throw new ScopeError(404, 'report_not_found', 'No such report.');
}
