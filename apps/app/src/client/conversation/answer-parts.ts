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
