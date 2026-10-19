/**
 * Imported FIRST by main.tsx, so it runs before routes.tsx creates the router
 * and reads the address: a shared link is stored and taken out of the URL
 * before anything else sees it (see share-target.ts).
 */
import { captureSharedDraft, sessionShareStorage } from './share-target.ts';

if (typeof window !== 'undefined') {
	try {
		captureSharedDraft(window.location, sessionShareStorage(), window.history);
	} catch {
		// A malformed address must never stop the app from starting.
	}
}
