#!/usr/bin/env bun
/**
 * Track 3, step 3.1: build the Flutter sandbox image.
 *
 *   CADDIE_LIVE_AUTHORIZED=1 bun scripts/build-flutter-image.ts
 *
 * Four PAID, non-disposable sandbox runs, each starting from the image the
 * previous one committed (Contree keeps result images 180 days):
 *   1 system   apt: OpenJDK 17, xz-utils, git (tag:tt-base:1 has no xz or git,
 *              and the flutter tool needs git)
 *   2 flutter  Flutter 3.44.8 (the version on the dev Mac), sha256-checked
 *              BEFORE unpacking, plus its Android engine files
 *   3 android  Android command-line tools (sha1-checked before unzipping),
 *              then platform-tools, android-36, build-tools 36.0.0 and NDK
 *              28.2.13676358 (Flutter 3.44.8's defaults)
 *   4 warm     the Flutter template (the files the image was warmed with; the app
 *              scaffold is now stacks/flutter/scaffold.ts): flutter create,
 *              pub get, test and a release APK, so the Gradle and pub caches
 *              are filled once; the build output is deleted again
 *
 * The sandbox has about 3.8 GB of memory, so Gradle's heap is capped at
 * 1.5 GB (Flutter's template asks for 8 GB). Progress is saved after each step
 * to $KIROCREW_SCRATCH/flutter-image-state.json, and a re-run resumes from the
 * last committed image. Refuses without CADDIE_LIVE_AUTHORIZED=1; prints no
 * credential values.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContreeClient, type ContreeOperation } from '../apps/app/src/server/adapters/contree.ts';
import { DEFAULT_BASE_IMAGE } from '../apps/app/src/server/build-sandbox.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
if (process.env.CADDIE_LIVE_AUTHORIZED !== '1') {
	console.error('build-flutter-image: BLOCKED — paid sandbox runs need CADDIE_LIVE_AUTHORIZED=1 (owner-approved).');
	process.exit(1);
}
const env: Record<string, string> = {};
if (existsSync(join(ROOT, '.dev.vars'))) {
	for (const line of readFileSync(join(ROOT, '.dev.vars'), 'utf8').split('\n')) {
		const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
		if (match) env[match[1]!] = match[2]!;
	}
}
const value = (key: string) => process.env[key] ?? env[key] ?? '';
if (!value('CONTREE_BASE_URL') || !value('CONTREE_API_TOKEN') || !value('CONTREE_PROJECT_ID')) {
	console.error('build-flutter-image: BLOCKED — CONTREE_BASE_URL/CONTREE_API_TOKEN/CONTREE_PROJECT_ID are not set.');
	process.exit(1);
}
const client = new ContreeClient({ baseUrl: value('CONTREE_BASE_URL'), apiToken: value('CONTREE_API_TOKEN'), platformProjectId: value('CONTREE_PROJECT_ID') });

// Pinned downloads, checked before anything is unpacked.
const FLUTTER = {
	version: '3.44.8',
	url: 'https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_3.44.8-stable.tar.xz',
	sha256: '672089e001571a9fbb209a495c583580c0c6c73ef98999264ba07fa93ace332d',
};
const CMDLINE_TOOLS = {
	url: 'https://dl.google.com/android/repository/commandlinetools-linux-16111833_latest.zip',
	sha1: 'e025545c62a8e64c7559119566a569fb1dec5f60',
};
const ANDROID_PACKAGES = ['platform-tools', 'platforms;android-36', 'build-tools;36.0.0', 'ndk;28.2.13676358'];

/** Every step runs with this environment; the base image leaves HOME unset. */
const RUN_ENV: Record<string, string> = {
	HOME: '/root',
	JAVA_HOME: '/usr/lib/jvm/java-17-openjdk-amd64',
	ANDROID_HOME: '/opt/android-sdk',
	ANDROID_SDK_ROOT: '/opt/android-sdk',
	PUB_CACHE: '/root/.pub-cache',
	FLUTTER_SUPPRESS_ANALYTICS: 'true',
	CI: 'true',
	PATH: '/opt/flutter/bin:/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
};

const TEMPLATE = join(ROOT, 'stacks', 'flutter', 'template');
const TEMPLATE_FILES = ['pubspec.yaml', 'analysis_options.yaml', 'lib/main.dart', 'test/widget_test.dart'];

interface Step {
	name: string;
	timeoutSec: number;
	command: string;
	files?: { path: string; local: string }[];
}

const STEPS: Step[] = [
	{
		name: 'system',
		timeoutSec: 900,
		command: [
			'set -eu',
			'export DEBIAN_FRONTEND=noninteractive',
			'apt-get update -qq',
			'apt-get install -y -qq --no-install-recommends openjdk-17-jdk-headless xz-utils git ca-certificates >/dev/null',
			'apt-get clean',
			'java -version 2>&1 | head -1',
			'git --version',
			'xz --version | head -1',
		].join('\n'),
	},
	{
		name: 'flutter',
		timeoutSec: 1800,
		command: [
			'set -eu',
			`curl -fsSL --retry 3 -o /tmp/flutter.tar.xz '${FLUTTER.url}'`,
			`echo '${FLUTTER.sha256}  /tmp/flutter.tar.xz' | sha256sum -c -`,
			'tar -xJf /tmp/flutter.tar.xz -C /opt',
			'rm -f /tmp/flutter.tar.xz',
			'git config --global --add safe.directory /opt/flutter',
			'flutter config --no-analytics --no-cli-animations >/dev/null',
			'flutter precache --android --no-ios --no-web --no-linux --no-windows --no-macos --no-fuchsia >/dev/null',
			'flutter --version | head -2',
		].join('\n'),
	},
	{
		name: 'android',
		timeoutSec: 1800,
		command: [
			'set -eu',
			`curl -fsSL --retry 3 -o /tmp/cmdline-tools.zip '${CMDLINE_TOOLS.url}'`,
			`echo '${CMDLINE_TOOLS.sha1}  /tmp/cmdline-tools.zip' | sha1sum -c -`,
			'mkdir -p /opt/android-sdk/cmdline-tools',
			'unzip -q /tmp/cmdline-tools.zip -d /tmp/cmdline-unpack',
			'mv /tmp/cmdline-unpack/cmdline-tools /opt/android-sdk/cmdline-tools/latest',
			'rm -f /tmp/cmdline-tools.zip',
			'yes | sdkmanager --licenses >/dev/null 2>&1 || true',
			`sdkmanager ${ANDROID_PACKAGES.map((p) => `'${p}'`).join(' ')} >/tmp/sdkmanager.log 2>&1 || { tail -20 /tmp/sdkmanager.log; exit 1; }`,
			'flutter config --android-sdk /opt/android-sdk >/dev/null',
			'yes | flutter doctor --android-licenses >/dev/null 2>&1 || true',
			'ls /opt/android-sdk/platforms /opt/android-sdk/build-tools /opt/android-sdk/ndk',
			'flutter doctor 2>&1 | grep -E "Flutter|Android toolchain" | head -2',
		].join('\n'),
	},
	{
		name: 'warm',
		timeoutSec: 3000,
		files: TEMPLATE_FILES.map((f) => ({ path: `/root/template/${f}`, local: join(TEMPLATE, f) })),
		command: [
			'set -eu',
			'flutter create --no-pub --platforms=android --org dev.caddie.app --project-name forge_flutter_template /root/warm/app >/dev/null',
			'cp -R /root/template/. /root/warm/app/',
			'cd /root/warm/app',
			// About 3.8 GB in the sandbox: cap Gradle, Kotlin and the worker count.
			"sed -i 's/^org.gradle.jvmargs=.*/org.gradle.jvmargs=-Xmx1536m -XX:MaxMetaspaceSize=512m/' android/gradle.properties",
			"printf 'kotlin.daemon.jvmargs=-Xmx512m\\norg.gradle.workers.max=2\\norg.gradle.daemon=false\\n' >> android/gradle.properties",
			'flutter pub get >/dev/null',
			'flutter test 2>&1 | tail -1',
			'start=$(date +%s)',
			'flutter build apk --release --target-platform android-arm64 2>&1 | tail -3',
			'echo "apk_build_seconds=$(( $(date +%s) - start ))"',
			'stat -c "apk_bytes=%s" build/app/outputs/flutter-apk/app-release.apk',
			// Keep the warm caches, drop the project and its build output.
			'cd / && find /root/warm /root/template -delete',
			'du -sh /root/.gradle /root/.pub-cache /opt/flutter /opt/android-sdk 2>/dev/null',
		].join('\n'),
	},
];

const STATE = join(process.env.KIROCREW_SCRATCH || '/tmp', 'flutter-image-state.json');
interface State {
	image: string;
	done: { step: string; image: string; operationId: string; durationMs: number | null; cost: unknown; stdout: string }[];
	pending?: { step: string; operationId: string };
}
const state: State = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { image: await client.resolveImageRef(DEFAULT_BASE_IMAGE), done: [] };
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
save();

async function waitFor(operationId: string, timeoutSec: number): Promise<ContreeOperation> {
	const deadline = Date.now() + (timeoutSec + 120) * 1000;
	let op = await client.getOperation(operationId);
	while (op && ['PENDING', 'ASSIGNED', 'EXECUTING'].includes(op.state) && Date.now() < deadline) {
		await Bun.sleep(5000);
		op = await client.getOperation(operationId);
	}
	if (!op) throw new Error(`operation ${operationId} not found`);
	return op;
}

async function rawCost(operationId: string): Promise<unknown> {
	const response = await fetch(`${value('CONTREE_BASE_URL')}/v1/operations/${encodeURIComponent(operationId)}`, {
		headers: { authorization: `Bearer ${value('CONTREE_API_TOKEN')}`, project: value('CONTREE_PROJECT_ID') },
	});
	if (!response.ok) return null;
	const body = (await response.json()) as { metadata?: { result?: { resources?: { cost?: unknown } } } };
	return body.metadata?.result?.resources?.cost ?? null;
}

console.log(`start image ${state.image}; ${state.done.length} of ${STEPS.length} steps already done`);
for (const step of STEPS) {
	if (state.done.some((d) => d.step === step.name)) continue;
	let operationId = state.pending?.step === step.name ? state.pending.operationId : '';
	if (!operationId) {
		const files = [];
		for (const file of step.files ?? []) {
			const record = await client.uploadFileBytes(new Uint8Array(readFileSync(file.local)));
			files.push({ path: file.path, uuid: record.uuid, mode: '0644' });
		}
		({ operationId } = await client.spawnInstance({ image: state.image, command: step.command, shell: true, disposable: false, timeoutSec: step.timeoutSec, env: RUN_ENV, files, truncateOutputAt: 256 * 1024 }));
		state.pending = { step: step.name, operationId };
		save();
	}
	console.log(`[${step.name}] operation ${operationId} running…`);
	const op = await waitFor(operationId, step.timeoutSec);
	const cost = await rawCost(operationId);
	console.log(`[${step.name}] ${op.state} exit=${op.exitCode} ${Math.round((op.durationMs ?? 0) / 1000)} s cost(raw)=${JSON.stringify(cost)}`);
	console.log(op.stdout.trim().split('\n').slice(-12).map((l) => `  ${l}`).join('\n'));
	if (op.state !== 'SUCCEEDED' || op.exitCode !== 0 || !op.resultImage) {
		console.log(`[${step.name}] FAILED${op.timedOut ? ' (timed out)' : ''}\n${op.stderr.trim().slice(-2000)}`);
		delete state.pending;
		save();
		process.exit(1);
	}
	state.image = op.resultImage;
	state.done.push({ step: step.name, image: op.resultImage, operationId, durationMs: op.durationMs, cost, stdout: op.stdout.trim().slice(-2000) });
	delete state.pending;
	save();
}
console.log(`FLUTTER IMAGE READY: ${state.image}`);
