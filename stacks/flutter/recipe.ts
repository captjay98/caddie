import type { StackRecipe } from "@caddie/contracts";

/**
 * flutter stack recipe, default backend = the proven Hono API (P09 stack).
 * Real device evidence (APK + emulator interaction) is the acceptance bar —
 * a web screenshot is never sufficient. Live verification is BLOCKED on the
 * P09 live window + Android SDK/emulator availability.
 */
export const recipe: StackRecipe = {
	id: "flutter",
	version: "1.0.0",
	imageDigest: "sha256:TEMPLATE-FROZEN-AT-P15D",
	install: ["flutter pub get"],
	test: ["flutter test"],
	build: ["flutter build apk --debug"],
	start: ["flutter emulators --launch caddie-test"],
	requiredCapabilities: ["flutter", "android-sdk", "emulator"],
	artifacts: ["build/app/outputs/flutter-apk/"],
	preview: "android-emulator",
	availability: "unverified",
};
