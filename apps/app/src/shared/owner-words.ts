/**
 * The project card shows "Who it's for" and "The problem" in quotation marks,
 * as the person's own words. The model kept paraphrasing — and once invented a
 * detail ("we log on paper", Poultry Tracker 2026-10-29) the person never said.
 * A quote is shown only when the person really wrote it; otherwise it is left
 * out rather than put in their mouth.
 */
const normal = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** The text when it appears word for word in what the person wrote, else undefined. */
export function ownWordsOrNothing(text: string | undefined, said: readonly string[]): string | undefined {
	const quote = text ? normal(text) : '';
	if (quote.length < 3) return undefined;
	return said.some((message) => normal(message).includes(quote)) ? text!.trim() : undefined;
}

/** Keep the newest messages, bounded, for the check above. */
export function rememberSaid(previous: readonly string[], message: string, limit = 12): string[] {
	const trimmed = message.trim().slice(0, 2000);
	return trimmed ? [...previous, trimmed].slice(-limit) : [...previous];
}
