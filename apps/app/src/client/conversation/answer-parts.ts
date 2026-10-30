import type { FlueConversationMessage, FlueConversationPart } from '@flue/react';

/**
 * The parts an assistant turn shows as its answer, in order: everything except
 * reasoning and tool calls (both are folded at the turn level).
 *
 * A model can stream one answer in pieces with its thinking in between ("The",
 * reasoning, " Nebius x NVIDIA ..."). Drawn one block per piece, the first
 * word sat alone above a blank line (live finding, 2026-10-20). So text parts
 * of the SAME message that only reasoning separates are joined exactly as
 * streamed, the later piece's fields (its streaming state) winning. Text on
 * either side of anything else (a tool call, a card, a file) stays its own
 * block, and two messages are never glued together.
 */
/**
 * The answer a person reads for a turn that used tools: only the words AFTER
 * the last tool call. Text written between tool calls is Caddie narrating its
 * own work ("I'll delegate the product specialist…", "The specialist reported
 * its save was refused by the host…", Poultry Tracker 2026-10-29) — it stays
 * in the turn's work summary, not in the reply. Cards and files always show.
 * A turn that ended on a tool call keeps its last sentence before it, so a
 * finished turn is never blank.
 */
export function finalAnswerParts(messages: readonly FlueConversationMessage[]): FlueConversationPart[] {
	let lastTool = -1;
	let position = 0;
	for (const message of messages) for (const part of message.parts) {
		if (part.type === 'dynamic-tool') lastTool = position;
		position += 1;
	}
	if (lastTool < 0) return answerParts(messages);
	let fallback = -1;
	let after = false;
	position = 0;
	for (const message of messages) for (const part of message.parts) {
		if (position > lastTool && part.type === 'text' && part.text.trim()) after = true;
		if (position < lastTool && part.type === 'text' && part.text.trim()) fallback = position;
		position += 1;
	}
	position = 0;
	const kept = messages.map((message) => ({
		...message,
		parts: message.parts.filter((part) => {
			const at = position++;
			if (part.type !== 'text' || at > lastTool) return true;
			return !after && at === fallback;
		}),
	}));
	return answerParts(kept);
}

export function answerParts(messages: readonly FlueConversationMessage[]): FlueConversationPart[] {
	const answer: FlueConversationPart[] = [];
	for (const message of messages) {
		// True while the last answer part is this message's text and only
		// reasoning has come since.
		let joinable = false;
		for (const part of message.parts) {
			if (part.type === 'reasoning') continue;
			if (part.type === 'dynamic-tool') {
				joinable = false;
				continue;
			}
			const last = answer[answer.length - 1];
			if (part.type === 'text' && joinable && last?.type === 'text') {
				answer[answer.length - 1] = { ...last, ...part, text: last.text + part.text };
				continue;
			}
			answer.push(part);
			joinable = part.type === 'text';
		}
	}
	return answer;
}
