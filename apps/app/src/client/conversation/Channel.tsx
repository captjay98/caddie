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
 *   dynamic-tool  -> consecutive calls cluster into ONE quiet strip behind a
 *                    "Caddie is working · N tool calls" summary (design
 *                    prototype, chat context: tool calls are quiet — a thin
 *                    strip, not banners competing with the assistant's words)
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

type ToolPart = Extract<FlueConversationPart, { type: 'dynamic-tool' }>;

/** Render item after clustering: a single part, or a run of tool calls. */
type PartCluster = { kind: 'single'; part: FlueConversationPart } | { kind: 'tools'; parts: ToolPart[] };

function clusterParts(parts: FlueConversationPart[]): PartCluster[] {
	const items: PartCluster[] = [];
	for (const part of parts) {
		if (part.type === 'dynamic-tool') {
			const last = items[items.length - 1];
			if (last && last.kind === 'tools') last.parts.push(part);
			else items.push({ kind: 'tools', parts: [part] });
		} else {
			items.push({ kind: 'single', part });
		}
	}
	return items;
}

/**
 * Consecutive assistant messages that carry ONLY tool calls merge into one
 * strip at the transcript level. A run emits a tool-per-message sequence
 * (1 call, 2 calls, …) that would otherwise render as a wall of one-line
 * strips with nothing readable between them.
 */
type MessageGroup = { messages: FlueConversationMessage[]; toolsOnly: boolean };

function groupMessages(messages: readonly FlueConversationMessage[]): MessageGroup[] {
	const groups: MessageGroup[] = [];
	for (const message of messages) {
		if (message.display === 'hidden') continue;
		const toolsOnly =
			message.role === 'assistant' &&
			message.parts.length > 0 &&
			message.parts.every((part) => part.type === 'dynamic-tool');
		const last = groups[groups.length - 1];
		if (toolsOnly && last && last.toolsOnly) last.messages.push(message);
		else groups.push({ messages: [message], toolsOnly });
	}
	return groups;
}

function turnClock(timestamp: string | undefined): string {
	if (!timestamp) return '';
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return '';
	const hh = String(date.getHours()).padStart(2, '0');
	const mm = String(date.getMinutes()).padStart(2, '0');
	return `${hh}:${mm}`;
}

/** Full date + time for the hover/tap tooltip; the visible transcript shows
 *  day dividers instead of per-message clocks. */
function fullTime(timestamp: string | undefined): string | undefined {
	if (!timestamp) return undefined;
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return undefined;
	return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** Day-group label for the transcript: Today / Yesterday / short date. */
function dayLabel(timestamp: string | undefined): string | null {
	if (!timestamp) return null;
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return null;
	const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
	const diff = Math.round((day(new Date()) - day(date)) / 86_400_000);
	if (diff === 0) return 'Today';
	if (diff === 1) return 'Yesterday';
	return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

function ToolBanner({ part }: { part: ToolPart }): ReactElement {
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

function ToolStrip({ parts }: { parts: ToolPart[] }): ReactElement {
	const running = parts.some((part) => part.state === 'input-available');
	const failed = parts.filter((part) => part.state === 'output-error').length;
	const totalMs = parts.reduce((sum, part) => sum + (typeof part.durationMs === 'number' ? part.durationMs : 0), 0);
	const calls = `${parts.length} tool call${parts.length === 1 ? '' : 's'}`;
	const summary = failed > 0
		? `Caddie worked · ${calls} · ${failed} failed`
		: running
			? `Caddie is working · ${calls}`
			: `Caddie worked · ${calls}${totalMs > 0 ? ` · ${Math.round(totalMs / 100) / 10}s` : ''}`;
	return (
		<details className="tool-strip" data-testid="tool-strip">
			<summary>{summary}</summary>
			{parts.map((part, index) => (
				<ToolBanner key={index} part={part} />
			))}
		</details>
	);
}

/** A run of tool-only assistant messages rendered as ONE quiet strip. */
function ToolGroup({ group, parts }: { group: readonly FlueConversationMessage[]; parts: ToolPart[] }): ReactElement {
	const clock = turnClock(group[0]?.timestamp);
	return (
		<div className="msg assistant" data-testid="msg-tool-group" title={fullTime(group[0]?.timestamp)}>
			<span className="sr-only">Caddie{clock ? ` at ${clock}` : ''}</span>
			<div className="bubble">
				<ToolStrip parts={parts} />
			</div>
		</div>
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
					Caddie is working
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

/** Transcript rows with day dividers (Today / Yesterday / short date between
 *  day groups); per-message clocks live in title tooltips only. */
function buildTranscriptRows(groups: ReturnType<typeof groupMessages>): ReactElement[] {
	const rows: ReactElement[] = [];
	let lastDay: string | null = null;
	let rowKey = 0;
	for (const group of groups) {
		if (group.toolsOnly) {
			const day = dayLabel(group.messages[0]?.timestamp);
			if (day !== null && day !== lastDay) {
				rows.push(
					<div className="day-divider" key={`day-${rowKey++}`}>
						{day}
					</div>,
				);
				lastDay = day;
			}
			rows.push(
				<ToolGroup
					key={`group-${rowKey++}`}
					group={group.messages}
					parts={group.messages.flatMap((message) =>
						message.parts.filter((part): part is ToolPart => part.type === 'dynamic-tool'),
					)}
				/>,
			);
		} else {
			for (const message of group.messages) {
				if (message.display === 'hidden') continue;
				const day = dayLabel(message.timestamp);
				if (day !== null && day !== lastDay) {
					rows.push(
						<div className="day-divider" key={`day-${rowKey++}`}>
							{day}
						</div>,
					);
					lastDay = day;
				}
				rows.push(<MessageRow key={message.id} message={message} />);
			}
		}
	}
	return rows;
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
			<div className="msg user" data-testid="msg-user" title={fullTime(message.timestamp)}>
				<span className="sr-only">You{clock ? ` at ${clock}` : ''}</span>
				<div className="bubble">{text}</div>
			</div>
		);
	}
	if (message.role !== 'assistant') return null; // system advisories surface via settlements
	const diagnostic = message.display === 'diagnostic';
	const body = (
		<>
			{clusterParts(message.parts).map((item, index) =>
				item.kind === 'tools' ? (
					<ToolStrip key={index} parts={item.parts} />
				) : (
					<AssistantPart key={index} part={item.part} />
				),
			)}
		</>
	);
	if (diagnostic) {
		return (
			<details className="msg assistant" data-testid="msg-diagnostic">
				<summary className="msg-meta kicker">Caddie · specialist diagnostic</summary>
				{body}
			</details>
		);
	}
	return (
		<div className="msg assistant" data-testid="msg-assistant" title={fullTime(message.timestamp)}>
			<span className="sr-only">Caddie{clock ? ` at ${clock}` : ''}</span>
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
	/** Mobile: the composer lives in the floating bottom bar (input above the
	 *  five nav items), so the pane renders the transcript alone. */
	composerHidden?: boolean;
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
						buildTranscriptRows(groupMessages(source.messages))
					)}

				{settledFailed.map((settlement) => (
					<p
						key={settlement.submissionId}
						className="settlement-banner"
						data-outcome={settlement.outcome}
						data-testid="settlement-banner"
						title={`submission ${settlement.submissionId} · ${settlement.outcome}`}
					>
						The run stopped before it finished. Nothing was written to the plan, and the failure is
						kept as evidence.
					</p>
				))}

				{live ? (
					<p className="thinking-line" role="status" data-testid="channel-status">
						Caddie is working
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
			{!props.composerHidden ? (
				<Composer
					onSend={props.onSend}
					disabled={live}
					disabledReason={live ? 'A run is working — wait for it to settle.' : undefined}
				/>
			) : null}
		</div>
	);
}
