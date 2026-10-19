import type { StackRecipe } from "@caddie/contracts";
import { FLUTTER_SCAFFOLD_DIGEST } from "./scaffold-lock.ts";

/**
 * flutter stack recipe (Track 3): a Flutter app plus the proven Hono backend,
 * built in the Flutter sandbox image (scripts/build-flutter-image.ts). The
 * commands are curated, never model-supplied, and match
 * stacks/flutter/scaffold.ts:
 *   install  caddie/setup.dart (Android + web projects, network permission,
 *            Gradle memory caps), pub packages against the content-hashed
 *            lockfile, then the server's frozen install (the host runs that one
 *            through verified-install.ts)
 *   test     caddie/run-tests.sh: the builder's widget tests in test/app, and
 *            the server's tests in src/ when there are any
 *   build    the web build (the preview) and the Workers server bundle
 * The release APK is built separately, at verify time
 * (FLUTTER_APK_COMMAND in scaffold.ts), because it needs the app's address.
 *
 * imageDigest binds the recipe to the exact scaffold the lockfiles were
 * proven with (scripts/refresh-flutter-scaffold-lock.ts --check).
 * Availability stays "unverified" until a live build through Caddie proves it.
 */
export const recipe: StackRecipe = {
	id: "flutter",
	version: "2.0.0",
	imageDigest: FLUTTER_SCAFFOLD_DIGEST,
	install: ["dart caddie/setup.dart", "flutter pub get --enforce-lockfile", "bun install --frozen-lockfile"],
	test: ["sh caddie/run-tests.sh"],
	build: ["flutter build web --release", "bun run build:server"],
	start: ["bun run start"],
	requiredCapabilities: ["flutter", "android-sdk", "bun"],
	artifacts: ["build/web/", "build/app/outputs/flutter-apk/", "dist/"],
	preview: "server",
	availability: "unverified",
};
