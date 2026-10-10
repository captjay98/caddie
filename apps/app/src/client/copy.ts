/**
 * copy.ts — the plain-words vocabulary (Caddie v2, HANDOFF §6).
 *
 * Every visible label uses these words: beginner-friendly, no jargon. The
 * words live here so screens, tabs and menus stay consistent. Technical words
 * are allowed only inside folded "For developers" sections.
 *
 * Rule: change visible labels, not identifiers — route paths, API names and
 * existing data-testids keep their names even when the word changes.
 */

export const WORDS = {
	/** Global destinations. */
	brief: 'Brief',
	discover: 'Discover',
	projects: 'Projects',
	/** The assistant. Never "Chat", never "the bot". */
	caddie: 'Caddie',
	/** Project steps (§3.7). Share replaces Submit for personal projects. */
	plan: 'Plan',
	build: 'Build',
	check: 'Check',
	submit: 'Submit',
	share: 'Share',
	/** Build internals. */
	files: 'Files',
	/** Account surfaces. */
	routines: 'Routines',
	memory: 'What Caddie knows',
	connectedAccounts: 'Connected accounts',
	spending: 'Spending',
	appearance: 'Appearance',
	/** Naming things. */
	toDo: 'To-do',
	toDos: 'To-dos',
	aBuild: 'a build',
	buildTools: 'Build tools',
	yourCodeOnGitHub: 'Your code on GitHub',
	/** Decisions. */
	approve: 'Looks good — build it',
	suggestChange: 'Suggest a change',
	/** Discovery. */
	canYouEnter: 'Can you enter?',
	/** The chat scope switch (§3.5). */
	talkingAbout: 'Talking about',
	everything: 'Everything',
} as const;

/** First names for greetings (U02 uses it for the composer placeholder). */
export const COMPOSER_PLACEHOLDER = 'Ask Caddie or tell it what to do…';

/** The mobile ask bar that sits above the tab bar on non-Caddie tabs (§3.4). */
export const ASK_BAR_PLACEHOLDER = 'Ask Caddie…';
