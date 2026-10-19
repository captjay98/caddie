import { FLUTTER_SCAFFOLD_COMMANDS } from "../../../../stacks/flutter/scaffold.ts";
import { SCAFFOLD_COMMANDS } from "../../../../stacks/react-hono/scaffold.ts";
import { parseTestCounts } from "./build-timeline.ts";
import { VERIFIED_INSTALL_COMMAND } from "./verified-install.ts";

/**
 * The host-owned checks for each kind of app, in order. Fixed recipe commands
 * (never model-supplied); every one is receipt-checked by coordinator-host.ts.
 *
 *   web app      install packages, behaviour tests, browser build
 *   Android app  (Track 3) Android + web project setup and pub packages, then
 *                the same three for the Flutter app and its server. The
 *                timeouts are longer: the first setup creates the Android
 *                project, and flutter's test and web build compile Dart.
 */
export interface HostCheck {
	check: "app-setup" | "dependencies" | "behavior-tests" | "browser-bundle";
	command: string;
	timeoutMs: number;
}

export function hostCheckCommands(stack: "react-hono" | "flutter"): HostCheck[] {
	if (stack === "flutter") {
		return [
			{ check: "app-setup", command: FLUTTER_SCAFFOLD_COMMANDS.appSetup, timeoutMs: 10 * 60_000 },
			{ check: "dependencies", command: VERIFIED_INSTALL_COMMAND, timeoutMs: 10 * 60_000 },
			{ check: "behavior-tests", command: FLUTTER_SCAFFOLD_COMMANDS.test.join(" && "), timeoutMs: 10 * 60_000 },
			{ check: "browser-bundle", command: FLUTTER_SCAFFOLD_COMMANDS.build.join(" && "), timeoutMs: 10 * 60_000 },
		];
	}
	return [
		{ check: "dependencies", command: VERIFIED_INSTALL_COMMAND, timeoutMs: 120_000 },
		{ check: "behavior-tests", command: SCAFFOLD_COMMANDS.test.join(" && "), timeoutMs: 120_000 },
		{ check: "browser-bundle", command: SCAFFOLD_COMMANDS.build.join(" && "), timeoutMs: 120_000 },
	];
}

/**
 * A test run counts only when at least one test passed and none failed, read
 * from the runner's own summary (bun's "N pass", flutter's "+N: All tests
 * passed!", or both added up). The exit code is checked separately.
 */
export function testsPassed(output: string): boolean {
	const counts = parseTestCounts(output);
	return counts !== null && counts.passed > 0 && counts.failed === 0;
}
