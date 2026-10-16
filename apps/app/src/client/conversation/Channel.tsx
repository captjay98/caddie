import { ProjectWorkflow } from './ProjectWorkflow.tsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { FlueConversationMessage, FlueConversationPart } from '@flue/react';
import { safeParse } from 'valibot';
import { DecisionCardSchema, type DecisionCard as DecisionCardType } from '@caddie/contracts';
import { HackathonResultsCardSchema } from '@caddie/contracts';
import type { HackathonCandidate } from '@caddie/contracts';
import { HackathonResultsCard, HackathonDetailProvider } from './HackathonResultsCard.tsx';
import { ContestDetailPane } from '../discovery/ContestDetailPane.tsx';
import { metaParts } from './hackathon-format.ts';
import { ApprovalCardData, ApprovalCardView } from './ApprovalCard.tsx';
import { ProjectProposalCard, ProjectProposalData } from './ProjectProposalCard.tsx';
import { GuidedStepsCardData, GuidedStepsCardView } from './GuidedStepsCard.tsx';
import { Markdown } from '@caddie/ui/Markdown';
import { StatePanel } from '../states.tsx';
import { Icon } from '../icons.tsx';
import { DecisionCardView } from '../brief/DecisionCard.tsx';
import { Composer } from './Composer.tsx';
import type { ChannelDraft, ChannelSource } from './channel-store.ts';
import { cleanAssistantText } from './response-hygiene.ts';
import { attachedFileNames, stripAttachedFileText } from './image-attachments.ts';
import { settlementNotice } from './settlement-notice.ts';

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

/**
 * Consecutive assistant messages that carry ONLY tool calls merge into one
 * strip at the transcript level. A run emits a tool-per-message sequence
 * (1 call, 2 calls, …) that would otherwise render as a wall of one-line
 * strips with nothing readable between them.
 */
/**
 * A TURN is the unit the transcript renders as one bubble: either a single
 * user message, or a run of consecutive assistant messages (every message
 * Caddie produced answering the user). Grouping by turn — not by individual
 * model message — is what lets a turn's reasoning fold into ONE "Thought it
 * through" and its tool calls into ONE drawer, instead of a stack of boxes.
 */
type Turn = { role: 'user'; message: FlueConversationMessage } | { role: 'assistant'; messages: FlueConversationMessage[] };

function groupTurns(messages: readonly FlueConversationMessage[]): Turn[] {
	const turns: Turn[] = [];
	for (const message of messages) {
		if (message.display === 'hidden') continue;
		if (message.role === 'user') {
			turns.push({ role: 'user', message });
			continue;
		}
		if (message.role !== 'assistant') continue; // system advisories surface via settlements
		// A diagnostic (specialist) message stays its OWN turn — it is a distinct
		// foldable row, never merged into the normal answer bubble. Otherwise a
		// run of consecutive assistant messages collapses into one turn.
		const last = turns[turns.length - 1];
		const canMerge =
			message.display !== 'diagnostic' &&
			last?.role === 'assistant' &&
			last.messages.at(-1)?.display !== 'diagnostic';
		if (canMerge && last?.role === 'assistant') last.messages.push(message);
		else turns.push({ role: 'assistant', messages: [message] });
	}
	return turns;
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

/**
 * Human-readable action labels for the tool strip. The raw tool name is an
 * internal id ("find_hackathons", "research") and must NOT surface in the
 * normal view (coordinator instruction: keep tool names out of replies). An
 * unmapped tool falls back to a neutral "Working" rather than leaking its id.
 */
const TOOL_ACTION_LABELS: Record<string, { working: string; done: string }> = {
	find_hackathons: { working: 'Searching for hackathons', done: 'Searched for hackathons' },
	research: { working: 'Researching the web', done: 'Researched the web' },
	hackathon_details: { working: 'Looking up that hackathon', done: 'Looked up that hackathon' },
	create_project: { working: 'Setting up your project', done: 'Set up your project' },
	propose_project: { working: 'Writing up a project idea', done: 'Wrote up a project idea' },
	start_brainstorm: { working: 'Thinking about ideas with you', done: 'Thinking about ideas with you' },
	continue_project: { working: 'Updating your project', done: 'Updated your project' },
	update_profile: { working: 'Noting your preferences', done: 'Noted your preferences' },
	remember: { working: 'Remembering that', done: 'Remembered that' },
	inspect_repository: { working: 'Looking at your code', done: 'Looked at your code' },
	list_stacks: { working: 'Checking available stacks', done: 'Checked available stacks' },
	verify_build: { working: 'Verifying the build', done: 'Verified the build' },
	request_approval: { working: 'Asking for your go-ahead', done: 'Asked for your go-ahead' },
	report_blocker: { working: 'Noting what is blocking this', done: 'Noted what is blocking this' },
};

function toolActionLabel(toolName: string, done: boolean): string {
	const entry = TOOL_ACTION_LABELS[toolName];
	if (!entry) return done ? 'Worked' : 'Working';
	return done ? entry.done : entry.working;
}

function ToolBanner({ part }: { part: ToolPart }): ReactElement {
	const done = part.state === 'output-available';
	const failed = part.state === 'output-error';
	// Human action label — never the raw tool id. Failure says a step didn't
	// complete, still without naming the internal tool.
	const label = failed ? `${toolActionLabel(part.toolName, false)} — didn't complete` : toolActionLabel(part.toolName, done);
	return (
		<p className="tool-banner tool-row" data-state={part.state} data-part-kind="call" data-testid="tool-banner">
			<Icon
				name={done ? 'check' : failed ? 'alert' : 'play'}
				title={done ? 'done' : failed ? 'failed' : 'working'}
			/>{' '}
			{label}
		</p>
	);
}

function ToolStrip({ parts }: { parts: ToolPart[] }): ReactElement {
	const running = parts.some((part) => part.state === 'input-available');
	const failed = parts.filter((part) => part.state === 'output-error').length;
	const totalMs = parts.reduce((sum, part) => sum + (typeof part.durationMs === 'number' ? part.durationMs : 0), 0);
	const secs = Math.round(totalMs / 100) / 10;
	// Distinct human actions in this run (deduped, order-preserving) — the strip
	// summary names WHAT Caddie did, not raw tool ids or a bare step count.
	const actions = [...new Set(parts.map((p) => toolActionLabel(p.toolName, true)))];
	const actionPhrase = actions.length === 0
		? 'Worked'
		: actions.length <= 2
			? actions.join(' · ')
			: `${actions.slice(0, 2).join(' · ')} +${actions.length - 2} more`;
	const summary = running
		? `${actions.length ? actions[0]!.replace(/ed\b/, 'ing') : 'Working'}…`
		: failed > 0
			? `${actionPhrase} · ${failed} didn't complete${secs ? ` · ${secs}s` : ''}`
			: `${actionPhrase}${secs ? ` · ${secs}s` : ''}`;
	return (
		<details className="tool-strip" data-testid="tool-strip">
			<summary>{summary}</summary>
			{parts.map((part, index) => (
				<ToolBanner key={index} part={part} />
			))}
		</details>
	);
}

/** The reasoning part as the Channel receives it — accumulated text + stream state. */
type ReasoningPart = Extract<FlueConversationPart, { type: 'reasoning' }>;

/**
 * Live reasoning view (Stage 4). While the model thinks, its reasoning streams
 * into a dimmed, scrollable, foldable panel that is OPEN by default so the user
 * sees progress in real time; when the turn completes it COLLAPSES to a quiet
 * one-line "Thought it through" summary (openable, never auto-expanded again).
 *
 * This threads the needle on the C7 hard constraint ("raw chain-of-thought
 * never renders as a permanent human-facing block"): raw CoT is shown ONLY
 * transiently while streaming and behind an explicit disclosure afterwards —
 * never as settled prose, and always run through the same hygiene cleaner that
 * strips serialization fragments / nested tags. A redacted reasoning block
 * shows the marker only, never fabricated text.
 */
/**
 * Turn-level reasoning (one bubble, one disclosure). Every reasoning part the
 * turn produced — the model may emit several passes — folds into ONE "Thought
 * it through", instead of a stack of markers. OPEN while any pass is still
 * streaming so the user watches it think in real time; COLLAPSES to the quiet
 * one-liner when the turn settles (openable, never auto-expanded again).
 *
 * Threads the C7 hard constraint ("raw chain-of-thought never renders as a
 * permanent human-facing block"): raw CoT shows ONLY transiently while
 * streaming and behind an explicit disclosure afterwards — never settled
 * prose, always through the same hygiene cleaner. A fully-redacted turn shows
 * the marker only, never fabricated text.
 */
function TurnReasoning({ parts }: { parts: readonly ReasoningPart[] }): ReactElement | null {
	const streaming = parts.some((part) => part.state === 'streaming');
	const redactedOnly =
		parts.length > 0 &&
		parts.every((part) => (part as { redacted?: unknown }).redacted === true);
	// Merge every pass's accumulated text into one block (blank line between
	// passes), cleaned the same way assistant text is so no tag/serialization
	// noise leaks through.
	const text = parts
		.filter((part) => (part as { redacted?: unknown }).redacted !== true)
		.map((part) => (typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
		.map((raw) => cleanAssistantText(raw).trim())
		.filter(Boolean)
		.join('\n\n');

	// Hooks run unconditionally, before any early return (a reasoning part can
	// start empty and later gain text/stream; a conditional hook count crashes
	// the tree with "Rendered more hooks than during the previous render").
	const ref = useRef<HTMLDivElement>(null);
	const reasoningPinned = useRef(true);
	useEffect(() => {
		if (streaming && ref.current && reasoningPinned.current) {
			ref.current.scrollTop = ref.current.scrollHeight;
		}
	}, [streaming, text]);

	// Nothing to show and not streaming: render nothing (quiet by default).
	if (!streaming && !text && !redactedOnly) return null;

	const summary = streaming
		? 'Caddie is thinking…'
		: redactedOnly && !text
			? 'Reasoning (hidden by the model)'
			: 'Thought it through';

	return (
		<details className="reasoning-view" data-testid="reasoning-view" data-state={streaming ? 'streaming' : 'done'} open={streaming}>
			<summary className="reasoning-summary" role="status">
				<Icon name={streaming ? 'play' : 'check'} title={streaming ? 'thinking' : 'done'} />{' '}
				{summary}
			</summary>
			{text ? (
				<div
					className="reasoning-body"
					ref={ref}
					data-testid="reasoning-body"
					onScroll={(event) => {
						const el = event.currentTarget;
						reasoningPinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
					}}
				>
					{text}
				</div>
			) : redactedOnly ? (
				<p className="reasoning-redacted">The model kept this reasoning private.</p>
			) : null}
		</details>
	);
}

function AssistantPart({ part }: { part: FlueConversationPart }): ReactElement | null {
	if (part.type === 'text') {
		// R04 hygiene: strip reasoning tags / raw svg / serialization fragments /
		// empty placeholder chains that leak INSIDE a text part before Markdown.
		const clean = cleanAssistantText(part.text);
		return clean ? <Markdown text={clean} /> : null;
	}
		if (part.type === 'reasoning') {
			// Reasoning is hoisted to the TURN level (TurnReasoning) so every pass
			// folds into one disclosure; never rendered per-part here.
			return null;
		}
	if (part.type === 'dynamic-tool') {
		// Tool calls are hoisted to the TURN level (one drawer); not per-part.
		return null;
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
 if (part.type === 'data-projectWorkflow') {
  const data=part.data as {projectId?:unknown;name?:unknown};
  if(typeof data?.projectId !== 'string' || typeof data?.name !== 'string') return <p role="alert">The project card could not be loaded.</p>;
  return <ProjectWorkflow projectId={data.projectId} name={data.name}/>;
 }
	if (part.type === 'data-hackathonResults') {
		const parsed = safeParse(HackathonResultsCardSchema, part.data);
		if (!parsed.success) {
			return (
				<p className="tool-banner" data-state="output-error" data-testid="hk-payload-fault">
					[card] hackathon results payload did not match the contract — not rendered
				</p>
			);
		}
		return <HackathonResultsCard card={parsed.output} />;
	}
	if (part.type === 'data-projectProposal') {
		// Caddie proposes, the user creates: the card's identity is the SERVER
		// proposal id; only its "Start this project" button creates anything.
		const parsed = safeParse(ProjectProposalData, part.data);
		if (!parsed.success) {
			return (
				<p className="tool-banner" data-state="output-error" data-testid="proposal-payload-fault">
					[card] payload did not match the project proposal contract — not rendered as an action
				</p>
			);
		}
		return <ProjectProposalCard data={parsed.output} />;
	}
	if (part.type === 'data-approvalCard') {
		// B06: the in-chat "OK to spend?" card. Its identity is the SERVER
		// approval id; Allow / Not now POST the authenticated decision route
		// and the card state reloads from the server.
		const parsed = safeParse(ApprovalCardData, part.data);
		if (!parsed.success) {
			return (
				<p className="tool-banner" data-state="output-error" data-testid="approval-payload-fault">
					[card] payload did not match the approval card contract — not rendered as an action
				</p>
			);
		}
		return <ApprovalCardView data={parsed.output} />;
	}
	if (part.type === 'data-guidedSteps') {
		const parsed = safeParse(GuidedStepsCardData, part.data);
		if (!parsed.success) {
			return (
				<p className="tool-banner" data-state="output-error" data-testid="guided-steps-payload-fault">
					[card] guided-steps payload did not match the contract — not rendered as an action
				</p>
			);
		}
		return <GuidedStepsCardView data={parsed.output} />;
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
 *  day groups); per-message clocks live in title tooltips only. One row per
 *  TURN — a user message, or an assistant turn as one bubble. */
function buildTranscriptRows(turns: ReturnType<typeof groupTurns>): ReactElement[] {
	const rows: ReactElement[] = [];
  // A handoff may mention the same project again. Keep one live workspace
  // at its latest mention so previews cannot diverge across duplicate frames.
  const latestCards = new Map<string, FlueConversationPart>();
  for (const turn of turns) {
    const messages = turn.role === 'user' ? [turn.message] : turn.messages;
    for (const message of messages) for (const part of message.parts) {
      if (part.type !== 'data-projectWorkflow') continue;
      const data = part.data as { projectId?: unknown };
      if (typeof data?.projectId === 'string') latestCards.set(data.projectId, part);
    }
  }
	let lastDay: string | null = null;
	let rowKey = 0;
	// Author of the previously PUSHED turn ('user' | 'assistant' | null).
	// Consecutive turns by the same author hug; a day divider resets it so the
	// first bubble after a divider never hugs across the gap.
	let prevAuthor: 'user' | 'assistant' | null = null;
	// Drop a workflow card that is not the latest mention of its project.
	const keepPart = (part: FlueConversationPart) => {
		if (part.type !== 'data-projectWorkflow') return true;
		const data = part.data as { projectId?: unknown };
		return typeof data?.projectId !== 'string' || latestCards.get(data.projectId) === part;
	};
	for (const turn of turns) {
		const stamp = turn.role === 'user' ? turn.message.timestamp : turn.messages[0]?.timestamp;
		const day = dayLabel(stamp);
		if (day !== null && day !== lastDay) {
			rows.push(<div className="day-divider" key={`day-${rowKey++}`}>{day}</div>);
			lastDay = day;
			prevAuthor = null;
		}
		if (turn.role === 'user') {
			const followsSameAuthor = prevAuthor === 'user';
			rows.push(<UserRow key={turn.message.id} message={turn.message} followsSameAuthor={followsSameAuthor} />);
			prevAuthor = 'user';
			continue;
		}
		// Assistant turn: filter stale workflow cards, then render ONE bubble.
		const messages = turn.messages
			.map((message) => ({ ...message, parts: message.parts.filter(keepPart) }))
			.filter((message) => message.parts.length > 0 || message.display === 'diagnostic');
		if (messages.length === 0) continue;
		const followsSameAuthor = prevAuthor === 'assistant';
		rows.push(<AssistantTurn key={messages[0]!.id} messages={messages} followsSameAuthor={followsSameAuthor} />);
		prevAuthor = 'assistant';
	}
	return rows;
}

/** The user's own message — right-aligned bubble, attachments listed. */
function UserRow({ message, followsSameAuthor }: { message: FlueConversationMessage; followsSameAuthor?: boolean }): ReactElement {
	const clock = turnClock(message.timestamp);
	const raw = message.parts
		.filter((part): part is Extract<FlueConversationPart, { type: 'text' }> => part.type === 'text')
		.map((part) => part.text)
		.join('\n');
	const text = stripAttachedFileText(raw);
	const files = attachedFileNames(raw);
	return (
		<div className="msg user" data-testid="msg-user" data-seq={followsSameAuthor ? 'cont' : 'first'} title={fullTime(message.timestamp)}>
			<span className="sr-only">You{clock ? ` at ${clock}` : ''}</span>
			<div className="bubble">
				{text}
				{files.length ? (
					<span className="bubble-files" data-testid="msg-user-files">
						{text ? <br /> : null}
						Attached: {files.join(', ')}
					</span>
				) : null}
			</div>
		</div>
	);
}

/**
 * One assistant TURN as a single bubble (feature-ledger C7, redesigned): a
 * fixed order of at most three layers —
 *   1. ONE "Thought it through" disclosure merging every reasoning pass,
 *   2. ONE tool drawer holding every tool call in the turn,
 *   3. the answer (text + cards + files) across all the turn's messages, in
 *      order, with a hairline rule separating it from the folded layers.
 * A specialist DIAGNOSTIC turn renders as its own foldable row instead.
 */
function AssistantTurn({ messages, followsSameAuthor }: { messages: FlueConversationMessage[]; followsSameAuthor?: boolean }): ReactElement | null {
	const first = messages[0];
	if (!first) return null;
	const clock = turnClock(first.timestamp);
	const allParts = messages.flatMap((message) => message.parts);
	const reasoning = allParts.filter((part): part is ReasoningPart => part.type === 'reasoning');
	const tools = allParts.filter((part): part is ToolPart => part.type === 'dynamic-tool');
	// The answer: everything that is neither reasoning nor a tool call, in order
	// (text, cards, files, data disclosures). AssistantPart returns null for the
	// hoisted kinds, so filtering here keeps the key order clean.
	const answer = allParts.filter((part) => part.type !== 'reasoning' && part.type !== 'dynamic-tool');
	const hasFolded = reasoning.length > 0 || tools.length > 0;
	const hasAnswer = answer.some((part) => part.type !== 'text' || cleanAssistantText(part.text).trim().length > 0);

	const body = (
		<>
			{reasoning.length > 0 ? <TurnReasoning parts={reasoning} /> : null}
			{tools.length > 0 ? <ToolStrip parts={tools} /> : null}
			{hasAnswer ? (
				<div className={hasFolded ? 'turn-answer has-folded' : 'turn-answer'}>
					{answer.map((part, index) => (
						<AssistantPart key={index} part={part} />
					))}
				</div>
			) : null}
		</>
	);

	if (first.display === 'diagnostic') {
		return (
			<details className="msg assistant" data-testid="msg-diagnostic" data-seq={followsSameAuthor ? 'cont' : 'first'}>
				<summary className="msg-meta kicker">Caddie · specialist diagnostic</summary>
				<div className="bubble">{body}</div>
			</details>
		);
	}
	return (
		<div className="msg assistant" data-testid="msg-assistant" data-seq={followsSameAuthor ? 'cont' : 'first'} title={fullTime(first.timestamp)}>
			<span className="sr-only">Caddie{clock ? ` at ${clock}` : ''}</span>
			<div className="bubble">{body}</div>
		</div>
	);
}

function DraftRow(props: {
	draft: ChannelDraft;
	transportLive: boolean;
	onRetry: (id: string) => void;
	onEdit: (id: string) => void;
	onDiscard: (id: string) => void;
}): ReactElement {
	const { draft } = props;
	return (
		<div className="draft-row" data-state={draft.state} data-testid="draft-row">
			<span className="mono-id">
				{draft.state === 'cancelled'
					? 'cancelled — kept for reference'
					: 'Not sent'}{' '}
				{/* attempts counts FAILED TRANSPORT ATTEMPTS (the rejection handler
				    increments it) — display the true count, no +1: the original
				    send IS attempt one now that a transport exists. */}
				{draft.attempts > 0
					? ` · ${draft.attempts} ${draft.attempts === 1 ? 'attempt' : 'attempts'}`
					: ''}
				{' '}· key {draft.idempotencyKey.slice(5, 13)} — resends reuse it, so the server can never double-submit
			</span>
			<span className="draft-text">{draft.text}</span>
			{draft.state === 'unsent' ? (
				<span className="draft-actions">
					<button type="button" className="btn-ghost" data-testid="draft-retry" onClick={() => props.onRetry(draft.id)}>
						Send again
					</button>
					<button type="button" className="btn-ghost" data-testid="draft-edit" onClick={() => props.onEdit(draft.id)}>
						Edit
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
	/** The surrounding shell can supply a single contextual welcome. */
	hideEmptyState?: boolean;
	emptyTitle?: string;
	emptyDetail?: string;
	/** Mobile: the composer lives in the floating bottom bar (input above the
	 *  five nav items), so the pane renders the transcript alone. */
	composerHidden?: boolean;
	/** Controlled unsent typing (audit F01) — owned by the scoped channel
	 *  store so it survives navigation and reloads. */
	composerText?: string;
	onComposerTextChange?: (text: string) => void;
	/** The conversation scope is still resolving (e.g. the account Home project
	 *  is being created/fetched on a global route). Render an honest loading
	 *  state — NOT the empty "no project" prompt, and NOT an error. */
	resolving?: boolean;
	onSend: (text: string, attachments: readonly import('@caddie/contracts').InputAttachment[]) => void;
	onRetryDraft: (id: string) => void;
	onEditDraft: (id: string) => void;
	onDiscardDraft: (id: string) => void;
}): ReactElement {
	const { source, projectId } = props;
	const scrollRef = useRef<HTMLDivElement>(null);
	const pinnedToBottom = useRef(true);
	// §3.6: leftover typing restored from an earlier visit is labelled until it
	// is sent or cleared. "From earlier" = text is present and the user has not
	// typed in this visit — any edit (or clearing) retires the label, and a
	// fresh load of an untouched draft restores it.
	const userTyped = useRef(false);
	const draftNote = !userTyped.current && Boolean(props.composerText && props.composerText.trim() !== '');

	// Chat → detail pane (steering fix): clicking a hackathon in the chat card
	// opens the SAME pane the Discover list uses, instead of navigating to the
	// event page. The pane reads the home/project scope the conversation is
	// already bound to.
	const [detailCandidate, setDetailCandidate] = useState<HackathonCandidate | null>(null);
	const [checkingDetail, setCheckingDetail] = useState(false);
	async function checkDetailEligibility(candidateId: string) {
		if (!projectId) return;
		setCheckingDetail(true);
		try {
			await fetch(
				`/api/projects/${encodeURIComponent(projectId)}/discovery/candidates/${encodeURIComponent(candidateId)}/check-eligibility`,
				{ method: 'POST', credentials: 'same-origin' },
			);
		} finally {
			setCheckingDetail(false);
		}
	}
	const handleComposerTextChange = (text: string) => {
		userTyped.current = true;
		props.onComposerTextChange?.(text);
	};

	useEffect(() => {
		const el = scrollRef.current;
		if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
	}, [source.messages, props.drafts, source.status]);

	// THE navigation performance fix: the rows (and every Markdown block in
	// them) are built only when the messages or drafts actually change. Without
	// this, every chrome re-render — i.e. every route change — re-parsed the
	// whole conversation transcript in react-markdown (~8.5s blocking on long
	// histories, measured).
	const transcriptRows = useMemo(
		() => buildTranscriptRows(groupTurns(source.messages)),
		[source.messages],
	);

	const live = source.status === 'connecting' || source.status === 'submitted' || source.status === 'streaming';
	const latestSettlement = source.settlements.at(-1);
	const settledFailed = !live && latestSettlement && latestSettlement.outcome !== 'completed' ? [latestSettlement] : [];

	// Live activity (what Caddie is DOING, not just "working"): read the current
	// turn's parts for the running tool-call count and the most recent tool name,
	// plus whether it is mid-reasoning. All real data from the transport — a
	// quiet turn simply shows the plain "working" line.
	const liveActivity = useMemo(() => {
		if (!live) return null;
		const lastAssistant = [...source.messages].reverse().find((m) => m.role === 'assistant');
		if (!lastAssistant) return null;
		const toolParts = lastAssistant.parts.filter((p) => typeof p.type === 'string' && p.type.startsWith('tool-'));
		const latestTool = toolParts.at(-1);
		const toolName = latestTool ? String(latestTool.type).slice('tool-'.length) : null;
		const reasoning = lastAssistant.parts.some((p) => p.type === 'reasoning' && (p as { state?: string }).state === 'streaming');
		return { toolCount: toolParts.length, toolName, reasoning };
	}, [live, source.messages]);


	if (props.resolving && !projectId) {
		return (
			<div className="channel-pane" data-testid="channel" data-channel-state="resolving">
				<div className="transcript">
					<StatePanel kind="loading" title="Connecting your assistant…" />
				</div>
			</div>
		);
	}

	if (!projectId) {
		return (
			<div className="channel-pane" data-testid="channel" data-channel-state="no-project">
				<div className="transcript">
					<StatePanel
						kind="empty"
						title="No conversation here yet"
						detail="This screen has no conversation scope. Open a project, or head to the Caddie tab to talk to Caddie."
					/>
				</div>
			</div>
		);
	}


	return (
		<HackathonDetailProvider value={{ openDetail: (candidate) => setDetailCandidate(candidate) }}>
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
				{source.messages.length === 0 && !props.hideEmptyState ? (
					<StatePanel
						kind="empty"
						title={props.emptyTitle ?? "Say hello — your first message starts a run"}
						detail={
							props.emptyDetail ?? (props.transportLive
								? 'Tell Caddie what you want in plain words. It drafts a plan, shows you where every fact came from, and waits for your OK before building anything. Every message is answered at most once.'
								: 'Tell Caddie what you want in plain words. It drafts a plan, shows you where every fact came from, and waits for your OK before building anything.')
						}
					/>
) : (
						transcriptRows
					)}

				{settledFailed.map((settlement) => {
					const notice = settlementNotice(settlement);
					return (
						<p
							key={settlement.submissionId}
							className="settlement-banner"
							data-outcome={settlement.outcome}
							data-kind={notice.kind}
							data-testid="settlement-banner"
							title={`submission ${settlement.submissionId} · ${settlement.outcome}`}
						>
							<strong>{notice.title}</strong> {notice.detail}
						</p>
					);
				})}

				<ProjectWorkflow key={projectId} projectId={projectId} showTranscript={false}/>
				{live ? (
					<div className="channel-activity" role="status" data-testid="channel-status">
						<span className="channel-activity-dot" aria-hidden="true" />
						<span className="channel-activity-label">
							{liveActivity?.reasoning
								? 'Caddie is thinking…'
								: liveActivity?.toolName
									? // Plain action ("Searching for hackathons…"), never the raw
										// tool id; an unmapped tool reads "Working…".
										`${toolActionLabel(liveActivity.toolName, false)}…`
									: 'Caddie is working'}
						</span>
						{liveActivity && liveActivity.toolCount > 0 ? (
							<span className="channel-activity-count">
								{liveActivity.toolCount} {liveActivity.toolCount === 1 ? 'step' : 'steps'}
							</span>
						) : null}
					</div>
				) : null}
				{source.status === 'error' ? (
					<div className="conv-offline" role="status" data-testid="channel-offline">
						<Icon name="alert" title="Connection problem" />
						<span>
							Caddie can't be reached right now. What you send waits here until you send it again.
						</span>
					</div>
				) : null}

				{props.drafts.map((draft) => (
					<DraftRow
						key={draft.id}
						draft={draft}
						transportLive={props.transportLive === true}
						onRetry={props.onRetryDraft}
						onEdit={props.onEditDraft}
						onDiscard={props.onDiscardDraft}
					/>
				))}
			</div>
			{!props.composerHidden ? (
				<Composer
					onSend={props.onSend}
					disabled={live}
					disabledReason={live ? 'A run is working — wait for it to settle.' : undefined}
					value={props.composerText}
					onValueChange={handleComposerTextChange}
					draftNote={draftNote ? 'Draft from earlier · not sent yet' : undefined}
				/>
			) : null}
		</div>
		{detailCandidate && projectId ? (
			<ContestDetailPane
				projectId={projectId}
				candidateId={detailCandidate.id}
				onClose={() => setDetailCandidate(null)}
				metaParts={metaParts(detailCandidate)}
				autoCheckOnOpen
				checking={checkingDetail}
				onCheck={() => void checkDetailEligibility(detailCandidate.id)}
			/>
		) : null}
		</HackathonDetailProvider>
	);
}
