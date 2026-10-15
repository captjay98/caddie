import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchJson, postJson } from '../api.ts';
import { failureKind, StatePanel } from '../states.tsx';
import { useProjects, useSessionActor } from '../queries.ts';

/**
 * P14 memory management UI (feature-ledger H10): inspect, confirm, correct
 * and retract the user's memory facts.
 *
 * Honesty rules mirrored from the service:
 *   - Retract IS deletion: the fact leaves the live list and never returns to
 *     injection; it stays visible in the "history" area as retracted proof
 *     that deletion is soft, and the row is never destroyed server-side.
 *   - Proposed facts (agent-proposed) carry a visible "proposed" pill and a
 *     Confirm action; they are not treated as facts the agent may rely on
 *     until confirmed.
 *   - Correcting opens an inline editor; saving creates a new version and the
 *     old one moves to history.
 */

export interface MemoryFact {
	id: string;
	userId: string;
	projectId: string | null;
	kind: 'preference' | 'fact' | 'correction';
	content: string;
	status: 'proposed' | 'confirmed' | 'retracted';
	sourceRunId: string | null;
	correctsId: string | null;
	createdAt: string;
	updatedAt: string;
}

interface MemoryListResponse {
	facts: MemoryFact[];
}

/**
 * `embedded`: rendered under a page that already names the section (Settings
 * → "What Caddie knows"), so the panel drops its own card, label and heading
 * instead of repeating them inside a box.
 */
export function Memory({ embedded = false }: { embedded?: boolean } = {}): ReactElement {
	const actor = useSessionActor(true);
	const queryClient = useQueryClient();
	const [projectId, setProjectId] = useState<string>('');
	const projects = useProjects(useMemo(() => ({ actorId: actor.data ?? null }), [actor.data]));

	const list = useQuery({
		queryKey: ['memory', actor.data ?? 'pending', projectId || 'personal', 'management'],
		queryFn: () =>
			fetchJson<MemoryListResponse>(
				`/api/memory?includeRetracted=1${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`,
			),
		enabled: actor.data != null,
	});

	const invalidate = () => {
		void queryClient.invalidateQueries({ queryKey: ['memory'] });
	};

	const confirm = useMutation({
		mutationFn: (id: string) => postJson<{ fact: MemoryFact }>(`/api/memory/${encodeURIComponent(id)}/confirm`, {}),
		onSuccess: invalidate,
	});
	const retract = useMutation({
		mutationFn: (id: string) => postJson<{ fact: MemoryFact }>(`/api/memory/${encodeURIComponent(id)}/retract`, {}),
		onSuccess: invalidate,
	});
	const correct = useMutation({
		mutationFn: (input: { id: string; content: string }) =>
			postJson<{ fact: MemoryFact }>(`/api/memory/${encodeURIComponent(input.id)}/correct`, {
				content: input.content,
			}),
		onSuccess: invalidate,
	});

	if (actor.isPending || list.isPending) {
		return <StatePanel kind="loading" title="Loading your memory…" />;
	}
	if (actor.error || list.error) {
		const error = actor.error ?? list.error;
		return (
			<StatePanel
				kind={failureKind(error)}
				detail={error instanceof Error ? error.message : undefined}
				onRetry={list.error ? () => void list.refetch() : undefined}
			/>
		);
	}

	const facts = list.data?.facts ?? [];
	const active = facts.filter((fact) => fact.status !== 'retracted');
	const history = facts.filter((fact) => fact.status === 'retracted');

	return (
		<section className={embedded ? 'settings-section-body' : 'card-surface settings-panel'} data-testid="memory-panel" id="memory-panel">
			{embedded ? null : (
				<>
					<p className="kicker" data-tone="action">
						MEMORY
					</p>
					<h3 className="state-title">What Caddie remembers</h3>
				</>
			)}
			<label className={embedded ? 'settings-field memory-scope' : 'row'} htmlFor="memory-scope">
				<span className={embedded ? 'settings-field-label' : 'kicker'}>{embedded ? 'Showing' : 'SCOPE'}</span>
				<select
					className="input"
					id="memory-scope"
					data-testid="memory-scope"
					aria-label="Memory scope"
					value={projectId}
					onChange={(event) => setProjectId(event.target.value)}
				>
					<option value="">Personal — your account</option>
					{(projects.data?.projects ?? [])
						.filter((p) => p.kind !== 'home')
						.map((p) => (
							<option key={p.id} value={p.id}>
								{p.name}
							</option>
						))}
				</select>
			</label>
			<p className={embedded ? 'settings-row-detail' : 'state-detail'}>
				{embedded
					? 'Removed facts are never used again. They stay listed below so you can see what changed.'
					: 'Personal facts belong to you alone. Retracting removes a fact from every future use — it is never silently deleted, the retracted entry stays in history.'}
			</p>

			{active.length === 0 ? (
				<p className="state-detail" data-testid="memory-empty">
					{embedded ? 'Caddie hasn’t learned anything about you yet.' : 'Nothing remembered yet.'}
				</p>
			) : embedded ? (
				<ul className="settings-rows" data-testid="memory-list">
					{active.map((fact) => (
						<MemoryFactRow
							key={fact.id}
							embedded
							fact={fact}
							busy={confirm.isPending || retract.isPending || correct.isPending}
							onConfirm={() => confirm.mutate(fact.id)}
							onRetract={() => retract.mutate(fact.id)}
							onCorrect={(content) => correct.mutate({ id: fact.id, content })}
							error={confirm.error ?? retract.error ?? correct.error}
						/>
					))}
				</ul>
			) : (
				<div className="row-list" data-testid="memory-list">
					{active.map((fact) => (
						<MemoryFactRow
							key={fact.id}
							fact={fact}
							busy={confirm.isPending || retract.isPending || correct.isPending}
							onConfirm={() => confirm.mutate(fact.id)}
							onRetract={() => retract.mutate(fact.id)}
							onCorrect={(content) => correct.mutate({ id: fact.id, content })}
							error={confirm.error ?? retract.error ?? correct.error}
						/>
					))}
				</div>
			)}

			{history.length > 0 && embedded ? (
				<div data-testid="memory-history" className="settings-group">
					<h2 className="settings-subhead">Removed</h2>
					<ul className="settings-rows">
						{history.map((fact) => (
							<li className="settings-row memory-row-removed" key={fact.id} data-testid="memory-retracted">
								<div className="settings-row-main">
									<span className="settings-row-title">{fact.content}</span>
								</div>
								<span className="status-pill" data-status="planned">Removed</span>
							</li>
						))}
					</ul>
				</div>
			) : history.length > 0 ? (
				<div data-testid="memory-history">
					<p className="kicker" data-tone="stale">
						HISTORY (RETRACTED)
					</p>
					<div className="row-list">
						{history.map((fact) => (
							<div className="inspector-row" key={fact.id} data-testid="memory-retracted">
								<div className="row-main">
									<span className="row-title">{fact.content}</span>
									<span className="status-pill" data-status="planned">
										retracted
									</span>
								</div>
							</div>
						))}
					</div>
				</div>
			) : null}
		</section>
	);
}

function MemoryFactRow(props: {
	fact: MemoryFact;
	busy: boolean;
	onConfirm: () => void;
	onRetract: () => void;
	onCorrect: (content: string) => void;
	error: unknown;
	embedded?: boolean;
}): ReactElement {
	const { fact } = props;
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(fact.content);
	if (props.embedded) return <CompactFactRow {...props} editing={editing} setEditing={setEditing} draft={draft} setDraft={setDraft} />;

	return (
		<div className="inspector-row" data-testid="memory-fact" data-status={fact.status}>
			<div className="row-main">
				<span className="row-title">{fact.content}</span>
				{/* §4: each fact says where it came from — real fields only. A
				    proposed fact is Caddie's unconfirmed guess; a confirmed one was
				    accepted in the chat; a correction replaces an earlier fact. */}
				<span className="row-status" data-testid="memory-kind">
					{fact.status === 'proposed'
						? 'Caddie guessed this — not confirmed'
						: fact.kind === 'correction'
							? 'You corrected this in chat'
							: 'You confirmed this in chat'}
					{fact.projectId ? ' · project' : ' · personal'}
				</span>
				<span className="status-pill" data-status={fact.status === 'proposed' ? 'needs-you' : 'handled'}>
					{fact.status}
				</span>
			</div>
			<div className="row-details">
				{fact.status === 'proposed' ? (
					<button
						type="button"
						className="btn-key"
						data-testid={`memory-confirm-${fact.id}`}
						disabled={props.busy}
						onClick={props.onConfirm}
					>
						Confirm
					</button>
				) : null}
				{editing ? (
					<span className="row">
						<input
							className="input"
							aria-label="Corrected wording"
							data-testid={`memory-correct-input-${fact.id}`}
							value={draft}
							onChange={(event) => setDraft(event.target.value)}
						/>
						<button
							type="button"
							className="btn-key"
							data-testid={`memory-correct-save-${fact.id}`}
							disabled={props.busy || draft.trim() === '' || draft.trim() === fact.content}
							onClick={() => {
								props.onCorrect(draft.trim());
								setEditing(false);
							}}
						>
							Save correction
						</button>
						<button type="button" className="btn-ghost" onClick={() => setEditing(false)}>
							Cancel
						</button>
					</span>
				) : (
					<button
						type="button"
						className="btn-ghost"
						data-testid={`memory-correct-${fact.id}`}
						disabled={props.busy}
						onClick={() => setEditing(true)}
					>
						Correct
					</button>
				)}
				<button
					type="button"
					className="btn-ghost"
					data-testid={`memory-retract-${fact.id}`}
					disabled={props.busy}
					onClick={props.onRetract}
				>
					Retract
				</button>
			</div>
			{props.error ? (
				<p className="form-error" role="alert" data-testid="memory-error">
					{props.error instanceof Error ? props.error.message : 'The memory change failed.'}
				</p>
			) : null}
		</div>
	);
}

/**
 * The Settings ("What Caddie knows") row: one plain row per fact — the fact,
 * a sentence-case line saying where it came from, and small inline actions.
 * Same test ids and behaviour as the full row; only the presentation differs.
 */
function CompactFactRow(props: {
	fact: MemoryFact;
	busy: boolean;
	onConfirm: () => void;
	onRetract: () => void;
	onCorrect: (content: string) => void;
	error: unknown;
	editing: boolean;
	setEditing: (editing: boolean) => void;
	draft: string;
	setDraft: (draft: string) => void;
}): ReactElement {
	const { fact, editing, setEditing, draft, setDraft } = props;
	const source =
		fact.status === 'proposed'
			? 'Caddie’s guess — not confirmed yet'
			: fact.kind === 'correction'
				? 'You corrected this'
				: 'You confirmed this';
	return (
		<li className="settings-row memory-row" data-testid="memory-fact" data-status={fact.status}>
			<div className="settings-row-main">
				{editing ? (
					<input
						className="input"
						aria-label="Corrected wording"
						data-testid={`memory-correct-input-${fact.id}`}
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
					/>
				) : (
					<span className="settings-row-title">{fact.content}</span>
				)}
				<span className="settings-row-detail" data-testid="memory-kind">
					{source} · {fact.projectId ? 'This project' : 'Personal'}
				</span>
				{props.error ? (
					<span className="form-error" role="alert" data-testid="memory-error">
						{props.error instanceof Error ? props.error.message : 'That change didn’t save.'}
					</span>
				) : null}
			</div>
			<div className="memory-actions">
				{editing ? (
					<>
						<button
							type="button"
							className="btn-key btn-sm"
							data-testid={`memory-correct-save-${fact.id}`}
							disabled={props.busy || draft.trim() === '' || draft.trim() === fact.content}
							onClick={() => {
								props.onCorrect(draft.trim());
								setEditing(false);
							}}
						>
							Save
						</button>
						<button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(false)}>
							Cancel
						</button>
					</>
				) : (
					<>
						{fact.status === 'proposed' ? (
							<button type="button" className="btn-key btn-sm" data-testid={`memory-confirm-${fact.id}`} disabled={props.busy} onClick={props.onConfirm}>
								Confirm
							</button>
						) : null}
						<button type="button" className="btn-ghost btn-sm" data-testid={`memory-correct-${fact.id}`} disabled={props.busy} onClick={() => setEditing(true)}>
							Edit
						</button>
						<button type="button" className="btn-ghost btn-sm" data-testid={`memory-retract-${fact.id}`} disabled={props.busy} onClick={props.onRetract}>
							Remove
						</button>
					</>
				)}
			</div>
		</li>
	);
}
