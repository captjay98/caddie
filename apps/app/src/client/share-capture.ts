/**
 * Imported FIRST by main.tsx, so it runs before routes.tsx creates the router
 * and reads the address: a shared link is stored and taken out of the URL
 * before anything else sees it (see share-target.ts), and so is the outcome
 * GitHub's return brings back (`?github=`, see github-return.ts).
 */
import { captureSharedDraft, sessionShareStorage } from './share-target.ts';
import { captureGithubReturn } from './github-return.ts';

if (typeof window !== 'undefined') {
	try {
		captureSharedDraft(window.location, sessionShareStorage(), window.history);
	} catch {
		// A malformed address must never stop the app from starting.
	}
	try {
		captureGithubReturn(window.location, sessionShareStorage(), window.history);
	} catch {
		// Same: the notice is skipped, the app starts.
	}
}
