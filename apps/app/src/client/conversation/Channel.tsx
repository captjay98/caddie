import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import type { FlueConversationMessage, FlueConversationPart } from '@flue/react';
import { safeParse } from 'valibot';
import { DecisionCardSchema, type DecisionCard as DecisionCardType } from '@caddie/contracts';
import { Markdown } from '@caddie/ui/Markdown';
import { StatePanel } from '../states.tsx';
import { Icon } from '../icons.tsx';
import { DecisionCardView } from '../brief/DecisionCard.tsx';
import { Composer } from './Composer.tsx';
import type { ChannelDraft, ChannelSource } from './channel-store.ts';

/**
 * The Channel — typed conversation rendering (feature-ledger row C7).
 *
 * Every part is rendered from its TYPE, never from parsed prose:
 *   text          -> Markdown (@caddie/ui)
 *   reasoning     -> a one-line working marker while streaming; DONE REASONING
 *                    IS NEVER RENDERED. No human-facing raw chain-of-thought,
 *                    ever (hard constraint + design direction).
 *   dynamic-tool  -> mono tool row: state glyph + queued/working/done/error + duration
 *   data-decision-card -> schema-validated DecisionCardView (unparsable
 *                    payloads render an honest fault, never a guess)
 *   data-*        -> collapsed specialist-data disclosure (display only)
 *   file          -> attachment chip with a real URL when one exists
 *
 * UI review board screen 08: turns carry author · time labels so a claim can
 * be traced to the run that made it; a tool call, an attachment and a data
 * disclosure are distinct row types; settlement states what changed and what
 * did not; the draft names the idempotency key as the duplicate-send guard.
 */

function turnClock(timestamp: string | undefined): string {
	if (!timestamp) return '';
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return '';
	const hh = String(date.getHours()).padStart(2, '0');
	const mm = String(date.getMinutes()).padStart(2, '0');
	return `${hh}:${mm}`;
}

function ToolBanner({ part }: { part: Extract<FlueConversationPart, { type: 'dynamic-tool' }> }): ReactElement {
	const stateWord =
		part.state === 'input-available'
			? 'working'
			: part.state === 'output-available'
				? `done${typeof part.durationMs === 'number' ? ` · ${Math.round(part.durationMs / 100) / 10}s` : ''}`
				: 'error';
	return (
		<p className="tool-banner tool-row" data-state={part.state} data-part-kind="call" data-testid="tool-banner">
			<Icon
				name={part.state === 'output-available' ? 'check' : part.state === 'output-error' ? 'alert' : 'play'}
				title={part.state === 'output-available' ? 'done' : part.state === 'output-error' ? 'failed' : 'working'}
			/>{' '}
			[{part.toolName}] {stateWord}
			{part.state === 'output-error' && part.errorText ? ` — ${part.errorText}` : ''}
		</p>
	);
}

function AssistantPart({ part }: { part: FlueConversationPart }): ReactElement | null {
	if (part.type === 'text') {
		return part.text.trim() ? <Markdown text={part.text} /> : null;
	}
	if (part.type === 'reasoning') {
		// Raw chain-of-thought never renders. Only a live progress marker.
		return part.state === 'streaming' ? (
			<p className="thinking-line" role="status" data-testid="thinking-line">
				specialist working{' '}
			</p>
		) : null;
	}
	if (part.type === 'dynamic-tool') {
		return <ToolBanner part={part} />;
	}
	if (part.type === 'file') {
		return (
			<p className="tool-banner" data-testid="file-chip">
				{part.url ? (
					<a href={part.url} target="_blank" rel="noreferrer">
						{part.filename ?? 'attachment'}
					</a>
				) : (
					(part.filename ?? 'attachment')
				)}
				{typeof part.size === 'number' ? ` · ${part.size}B` : ''}
			</p>
		);
	}
	if (part.type === 'data-decision-card') {
		const parsed = safeParse(DecisionCardSchema, part.data);
		if (!parsed.success) {
			return (
				<p className="tool-banner" data-state="output-error" data-testid="card-payload-fault">
					[card] payload did not match the DecisionCard contract — not rendered as an action
				</p>
			);
		}
		return <DecisionCardView card={parsed.output} />;
	}
	// any other data-* part: display-only collapsed disclosure
	const name = part.type.slice('data-'.length) || 'note';
	return (
		<details className="tool-banner" data-testid="data-part">
			<summary>specialist data · {name}</summary>
			<pre>{JSON.stringify((part as { data: unknown }).data, null, 2)}</pre>
		</details>
	);
}

function MessageRow({ message }: { message: FlueConversationMessage }): ReactElement | null {
	if (message.display === 'hidden') return null;
	const clock = turnClock(message.timestamp);
	if (message.role === 'user') {
		const text = message.parts
			.filter((part): part is Extract<FlueConversationPart, { type: 'text' }> => part.type === 'text')
			.map((part) => part.text)
			.join('\n');
		return (
			<div className="msg user" data-testid="msg-user">
				<span className="turn-label" data-testid="turn-label">
					You{clock ? ` · ${clock}` : ''}
				</span>
				<div className="bubble">{text}</div>
			</div>
		);
	}
	if (message.role !== 'assistant') return null; // system advisories surface via settlements
	const diagnostic = message.display === 'diagnostic';
	const body = (
		<>
			{message.parts.map((part, index) => (
				<AssistantPart key={index} part={part} />
			))}
		</>
	);
	if (diagnostic) {
		return (
			<details className="msg assistant" data-testid="msg-diagnostic">
				<summary className="msg-meta kicker">Caddie · specialist diagnostic{clock ? ` · ${clock}` : ''}</summary>
				{body}
			</details>
		);
	}
	return (
		<div className="msg assistant" data-testid="msg-assistant">
			<span className="turn-label" data-testid="turn-label">
				Caddie{clock ? ` · ${clock}` : ''}
			</span>
			<div className="bubble">{body}</div>
		</div>
	);
}

function DraftRow(props: {
	draft: ChannelDraft;
	transportLive: boolean;
	onRetry: (id: string) => void;
	onDiscard: (id: string) => void;
}): ReactElement {
	const { draft } = props;
	return (
		<div className="draft-row" data-state={draft.state} data-testid="draft-row">
			<span className="mono-id">
				{draft.state === 'cancelled'
					? 'cancelled — kept for reference'
					: props.transportLive
						? 'unsent · the run transport refused it'
						: 'unsent · held until you send'}{' '}
				· idempotency key {draft.idempotencyKey.slice(5, 13)} — the guard against a duplicate send
				{/* attempts counts FAILED TRANSPORT ATTEMPTS (the rejection handler
				    increments it) — display the true count, no +1: the original
				    send IS attempt one now that a transport exists. */}
				{draft.attempts > 0
					? ` · ${draft.attempts} ${draft.attempts === 1 ? 'attempt' : 'attempts'}`
					: ''}
			</span>
			<span className="draft-text">{draft.text}</span>
			{draft.state === 'unsent' ? (
				<span className="draft-actions">
					<button type="button" className="btn-ghost" data-testid="draft-retry" onClick={() => props.onRetry(draft.id)}>
						Retry
					</button>
					<button type="button" className="btn-ghost" data-testid="draft-discard" onClick={() => props.onDiscard(draft.id)}>
						Discard
					</button>
				</span>
			) : null}
		</div>
	);
}

export function Channel(props: {
	source: ChannelSource;
	drafts: readonly ChannelDraft[];
	projectId: string | null;
	/** True once the coordinator run transport is wired for this project. */
	transportLive?: boolean;
	onSend: (text: string) => void;
	onRetryDraft: (id: string) => void;
	onDiscardDraft: (id: string) => void;
}): ReactElement {
	const { source, projectId } = props;
	const scrollRef = useRef<HTMLDivElement>(null);
	const pinnedToBottom = useRef(true);

	useEffect(() => {
		const el = scrollRef.current;
		if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
	}, [source.messages, props.drafts, source.status]);

	if (!projectId) {
		return (
			<div className="channel-pane" data-testid="channel">
				<div className="transcript">
					<StatePanel
						kind="empty"
						title="No project selected"
						detail="Select or create a project — the conversation channel belongs to its run."
					/>
				</div>
			</div>
		);
	}

	const live = source.status === 'connecting' || source.status === 'submitted' || source.status === 'streaming';
	const settledFailed = source.settlements.filter((s) => s.outcome !== 'completed');

	return (
		<div className="channel-pane" data-testid="channel" data-transport-status={source.status}>
			<div
				className="transcript"
				data-testid="channel-transcript"
				ref={scrollRef}
				onScroll={(event) => {
					const el = event.currentTarget;
					pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
				}}
			>
				{source.messages.length === 0 ? (
					<StatePanel
						kind="empty"
						title="Say hello — your first message starts a run"
						detail={
							props.transportLive
								? 'Tell Caddie what you want in plain words. It drafts a plan, shows you where every fact came from, and waits for your OK before building anything. Every message is answered at most once.'
								: 'Tell Caddie what you want in plain words. It drafts a plan, shows you where every fact came from, and waits for your OK before building anything.'
						}
					/>
				) : (
					source.messages.map((message) => <MessageRow key={message.id} message={message} />)
				)}

				{settledFailed.map((settlement) => (
					<p
						key={settlement.submissionId}
						className="settlement-banner"
						data-outcome={settlement.outcome}
						data-testid="settlement-banner"
					>
						run stopped — submission {settlement.submissionId} {settlement.outcome}. Nothing was written to
						the plan after the stop; the failure is retained as evidence.
					</p>
				))}

				{live ? (
					<p className="thinking-line" role="status" data-testid="channel-status">
						working…{' '}
					</p>
				) : null}
				{source.status === 'error' ? (
					<StatePanel
						kind="error"
						title="The channel lost its connection"
						detail={source.error?.message ?? 'Unsent drafts below keep their retry affordance.'}
					/>
				) : null}

				{props.drafts.map((draft) => (
					<DraftRow
						key={draft.id}
						draft={draft}
						transportLive={props.transportLive === true}
						onRetry={props.onRetryDraft}
						onDiscard={props.onDiscardDraft}
					/>
				))}
			</div>
			<Composer
				onSend={props.onSend}
				disabled={live}
				disabledReason={live ? 'A run is working — wait for it to settle.' : undefined}
			/>
		</div>
	);
}
