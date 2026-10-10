import { useState } from 'react';
import type { ReactElement } from 'react';
import * as v from 'valibot';
import { postJson } from '../api.ts';

/**
 * The in-chat "OK to spend?" card (Caddie v2, HANDOFF §3.6, packet B06).
 *
 * The card's identity is the SERVER approval id carried in the typed data
 * part the coordinator writes; Allow / Not now call the authenticated
 * approvals API, and the card's state comes from the server's response (and
 * a reload shows the server state, not chat text). A card without a server
 * approval id can never approve anything — the view refuses to render an
 * actionable card for a payload whose approval id is missing.
 */

export const ApprovalCardData = v.pipe(
	v.object({
		approvalId: v.string(),
		projectId: v.string(),
		what: v.string(),
		capMinorUnits: v.nullable(v.number()),
		currency: v.nullable(v.string()),
		status: v.picklist(['pending', 'approved', 'rejected', 'expired']),
	}),
	v.readonly(),
);
export type ApprovalCardPayload = v.InferOutput<typeof ApprovalCardData>;

type ServerStatus = 'pending' | 'approved' | 'rejected' | 'expired';

const STATUS_LABEL: Record<ServerStatus, string> = {
	pending: 'Waiting for you',
	approved: 'Approved',
	rejected: 'Not now',
	expired: 'Expired',
};

export function ApprovalCardView(props: { data: ApprovalCardPayload }): ReactElement {
	const { data } = props;
	const [status, setStatus] = useState<ServerStatus>(data.status);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function decide(decision: 'approved' | 'rejected') {
		setBusy(true);
		setError(null);
		try {
			// Two server steps, never chat text: READ the approval to fetch its
			// real intent, then record the decision against that exact intent.
			// The card's next state is whatever the SERVER returns, not the click.
			const read = await fetch(`/api/approvals/${encodeURIComponent(data.approvalId)}`, {
				credentials: 'same-origin',
			});
			if (!read.ok) throw new Error(`could not read the approval (${read.status})`);
			const { approval } = (await read.json()) as {
				approval: {
					projectId: string;
					action: string;
					resourceId: string;
					revisionHash: string;
					policyVersion: string;
					status: ServerStatus;
				};
			};
			setStatus(approval.status === 'pending' ? approval.status : approval.status);
			const result = await postJson<{ approval: { status: ServerStatus } }>('/api/approvals', {
				intent: {
					projectId: approval.projectId,
					action: approval.action,
					resourceId: approval.resourceId,
					revisionHash: approval.revisionHash,
					policyVersion: approval.policyVersion,
				},
				decision,
			});
			setStatus(result.approval.status);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	const cap =
		data.capMinorUnits == null
			? 'Caddie will ask before anything costs money.'
			: `Uses up to ${(data.capMinorUnits / 100).toLocaleString(undefined, {
					style: 'currency',
					currency: data.currency ?? 'USD',
					maximumFractionDigits: 0,
				})}.`;

	return (
		<div className="approval-card" data-testid="approval-card" data-status={status}>
			<p className="kicker" data-tone="action">
				OK TO SPEND?
			</p>
			<p className="approval-what">{data.what}</p>
			<p className="state-detail">{cap}</p>
			{status === 'pending' ? (
				<div className="row-actions">
					<button type="button" className="btn-key" data-testid="approval-allow" disabled={busy} onClick={() => void decide('approved')}>
						{busy ? 'Saving…' : 'Allow'}
					</button>
					<button type="button" className="btn-ghost" data-testid="approval-not-now" disabled={busy} onClick={() => void decide('rejected')}>
						Not now
					</button>
				</div>
			) : (
				<p className="state-detail" data-testid="approval-status">
					{STATUS_LABEL[status]} — recorded on the server
				</p>
			)}
			{error ? (
				<div role="alert" className="sign-in-error" data-testid="approval-error">
					<b>The decision was not recorded.</b>
					<span> {error}</span>
				</div>
			) : null}
		</div>
	);
}
