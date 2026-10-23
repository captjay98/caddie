/**
 * The generated test-mode feature files an app gets from its APPROVED "How
 * your app works" block (plan parts J and L; lane 9 wrote the files in
 * stacks/react-hono/{payments,files}-files.ts). They are NOT in every app:
 *
 *   payments  when the block declares `payments`;
 *   files     when any table has a `file` field.
 *
 * Only for a project stamped with app features (`app_features`), so a judge's
 * app, or any app while the switch is off, never carries them. The host writes
 * them into the working copy at hand-out and before every check run, the same
 * way as the contract files, so a builder can't drop them; they are protected
 * (caddie/** and the two migrations, agents/permissions.ts).
 */

import type { ArchitectureBlock } from '@caddie/contracts';
import { SCAFFOLD_FEATURE_FILES } from '../../../../stacks/react-hono/scaffold.ts';

/** True when any table of the block stores a photo or file. */
export function blockHasFileField(block: ArchitectureBlock): boolean {
	return block.tables.some((table) => table.fields.some((field) => field.type === 'file'));
}

/** The feature files (path -> text) this block's app gets, or none. */
export function appFeatureFiles(block: ArchitectureBlock, options: { appFeatures: boolean }): Record<string, string> {
	if (!options.appFeatures) return {};
	return {
		...(block.payments ? SCAFFOLD_FEATURE_FILES.payments : {}),
		...(blockHasFileField(block) ? SCAFFOLD_FEATURE_FILES.files : {}),
	};
}
