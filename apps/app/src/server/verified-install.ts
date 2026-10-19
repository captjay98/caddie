import type { SandboxDriver, SandboxExecuteResult } from './adapters/sandbox.ts';
import { SCAFFOLD_COMMANDS } from '../../../../stacks/react-hono/scaffold.ts';

/**
 * THE verified install step: how every install path puts an app's packages in
 * place (owner review item 3, option (a)).
 *
 * WHY: the production base image (`tag:tt-base:1`, Bun 1.4.2) cannot unpack
 * some npm tarballs. `bun install --frozen-lockfile` exits 1 with
 * `error: Fail extracting tarball from react-dom`, and the build then cannot
 * resolve `react-dom/client`. GNU tar unpacks the same bytes fine. The only
 * recovery that existed was a hack in `scripts/run-journey.ts`: curl + tar for
 * each failing package, with no check of the bytes, which end up bundled into
 * published apps.
 *
 * WHAT IT DOES, for every package `bun.lock` pins from the npm registry:
 *   1. download that exact tarball;
 *   2. check its sha512 against the integrity in `bun.lock` BEFORE unpacking
 *      anything (a mismatch is never unpacked);
 *   3. unpack it with GNU tar into the folder its lock key names (`a/b` is
 *      `node_modules/a/node_modules/b`), so nested copies land where Bun puts
 *      them and Bun has nothing left to unpack;
 *   4. write a `.caddie-verified` marker holding the integrity it matched, so a
 *      later run skips that folder instead of downloading it again;
 * then run the recipe's unchanged `bun install --frozen-lockfile`. Bun finds
 * every package in place and checks the tree against the lock. It does not
 * re-read the bytes already in `node_modules`, which is why step 2 comes first.
 *
 * Fail closed: a download, check or unpack failure stops the step before the
 * frozen install, naming the package (never a hash). A registry entry with no
 * sha512 in the lock stops it too. Two kinds of entry are left to Bun: refs it
 * fetches itself (workspace, file, git, tarball URLs, custom registries — Bun
 * checks those downloads against the lock), and packages for another OS or CPU
 * (Bun skips them as well).
 *
 * The script is written into the sandbox on every run (a here-document in the
 * preflight command), because the app's folder may hold nothing but the copied
 * app. It runs under the sandbox's own `bun`, which parses the JSONC lock.
 *
 * Call sites: run_checks' dependencies check (a new app's first install and
 * every later check), the working-copy restart, and the copied-app preview.
 * The builder's own shell `bun add` still goes straight to Bun, which checks
 * what it downloads; the next run_checks unpacks anything Bun recorded in
 * `bun.lock` but could not unpack.
 */

/** End marker for the here-document that writes the script into the sandbox. */
const SCRIPT_HEREDOC = 'CADDIE_VERIFIED_INSTALL_EOF';

/** Where the script is written before it runs: `/tmp` is writable and keeps it out of the app. */
const SCRIPT_PATH = '/tmp/caddie-verified-install.mjs';

/**
 * The sandbox-side script, the step's single source of truth. A self-contained
 * ES module using only node built-ins and `fetch`, so it runs under the
 * sandbox's `bun` with nothing installed. Run as a file, it places the
 * packages; imported (tests/verified-install.test.ts), its exports are the
 * exact logic that ships.
 *
 * `CADDIE_NPM_REGISTRY` overrides the registry for the local test only; the
 * sandbox's env (BUILD_RUNTIME_ENV) never sets it.
 *
 * Kept free of backticks and dollar-brace (it is a String.raw template), and
 * of the frozen-install command text, so command matching elsewhere still sees
 * only the real install command.
 */
export const VERIFIED_INSTALL_SCRIPT = String.raw`import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MARKER = ".caddie-verified";
export const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const NAME_PART = /^[A-Za-z0-9._~-]+$/;
const VERSION_TEXT = /^[0-9A-Za-z.+_-]+$/;
const PARALLEL_DOWNLOADS = 4;
const UNPACK_TRIES = 2;

// bun.lock is JSONC: drop the trailing commas JSON.parse rejects, but only
// outside strings, so a comma inside a string is left alone.
export function stripTrailingCommas(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "]" || text[j] === "}") continue;
    }
    out += ch;
  }
  return out;
}

function plainPart(part) {
  return typeof part === "string" && NAME_PART.test(part) && part !== "." && part !== "..";
}

// A lock key is the package's place in node_modules: "a" is node_modules/a,
// "a/b" is node_modules/a/node_modules/b, and a scope keeps its two segments
// together ("@s/x/y" is node_modules/@s/x/node_modules/y). Anything that is not
// a plain package path gives null, so nothing is written outside node_modules.
export function installDirFor(key) {
  if (typeof key !== "string" || key.length === 0) return null;
  const segments = key.split("/");
  const parts = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.charAt(0) === "@") {
      const name = segments[i + 1];
      if (!plainPart(segment.slice(1)) || !plainPart(name)) return null;
      parts.push(segment + "/" + name);
      i++;
    } else {
      if (!plainPart(segment)) return null;
      parts.push(segment);
    }
  }
  return "node_modules/" + parts.join("/node_modules/");
}

// os and cpu in a lock entry are a string or a list, and "!x" excludes x.
export function platformMatches(meta, platform, arch) {
  const fits = (rule, value) => {
    const list = typeof rule === "string" ? [rule] : Array.isArray(rule) ? rule : [];
    if (list.length === 0) return true;
    if (list.indexOf("!" + value) !== -1) return false;
    const wanted = list.filter((item) => typeof item === "string" && item.charAt(0) !== "!");
    return wanted.length === 0 || wanted.indexOf(value) !== -1;
  };
  const m = meta && typeof meta === "object" ? meta : {};
  return fits(m.os, platform) && fits(m.cpu, arch);
}

// Every packages entry is [ref, registry, meta, integrity]; the ref is
// "name@version" (an alias key installs the real package under its own name).
export function parseLockPackages(lockText, platform, arch) {
  const result = { packages: [], leftToBun: [], otherPlatform: [], missingIntegrity: [] };
  let lock;
  try { lock = JSON.parse(stripTrailingCommas(lockText)); }
  catch (error) {
    result.parseError = String(error && error.message ? error.message : error);
    return result;
  }
  const entries = lock && lock.packages && typeof lock.packages === "object" ? lock.packages : {};
  for (const key of Object.keys(entries)) {
    const value = Array.isArray(entries[key]) ? entries[key] : [];
    const ref = typeof value[0] === "string" ? value[0] : "";
    const registry = typeof value[1] === "string" ? value[1] : "";
    const integrity = typeof value[3] === "string" ? value[3] : "";
    const at = ref.lastIndexOf("@");
    const name = at > 0 ? ref.slice(0, at) : "";
    const version = at > 0 ? ref.slice(at + 1) : "";
    const dir = installDirFor(key);
    const fromDefaultRegistry = ref.indexOf(":") === -1 && registry === "" && dir !== null &&
      installDirFor(name) !== null && VERSION_TEXT.test(version);
    if (!fromDefaultRegistry) { result.leftToBun.push(key); continue; }
    if (!platformMatches(value[2], platform, arch)) { result.otherPlatform.push(key); continue; }
    if (integrity.indexOf("sha512-") !== 0) { result.missingIntegrity.push(key); continue; }
    result.packages.push({ key: key, dir: dir, name: name, version: version, integrity: integrity });
  }
  return result;
}

// The registry tarball URL for a pinned name@version. A scoped name keeps its
// scope in the path and drops it from the file name.
export function tarballUrlFor(name, version, registryBase) {
  const base = (registryBase || DEFAULT_REGISTRY).replace(/\/+$/, "");
  const slash = name.indexOf("/");
  const fileName = name.charAt(0) === "@" && slash !== -1 ? name.slice(slash + 1) : name;
  return base + "/" + name + "/-/" + fileName + "-" + version + ".tgz";
}

// Compare the lock's "sha512-<base64>" with the digest of the downloaded bytes.
export function verifyIntegrity(expectedIntegrity, actualBase64) {
  if (typeof expectedIntegrity !== "string" || typeof actualBase64 !== "string") return false;
  if (expectedIntegrity.indexOf("sha512-") !== 0) return false;
  const expected = expectedIntegrity.slice("sha512-".length);
  if (expected.length !== actualBase64.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ actualBase64.charCodeAt(i);
  return difference === 0;
}

// Clear what an earlier copy left in a package folder, except the folder's own
// node_modules, where its nested packages live.
function clearCopy(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry !== "node_modules") rmSync(join(dir, entry), { recursive: true, force: true });
  }
}

async function placePackage(cwd, pkg, registryBase) {
  const dir = join(cwd, pkg.dir);
  const marker = join(dir, MARKER);
  if (existsSync(marker) && existsSync(join(dir, "package.json")) && readFileSync(marker, "utf8") === pkg.integrity) {
    return { already: true };
  }
  const label = pkg.name + "@" + pkg.version + (pkg.key === pkg.name ? "" : " (at " + pkg.key + ")");
  let bytes;
  try {
    const response = await fetch(tarballUrlFor(pkg.name, pkg.version, registryBase));
    if (!response.ok) return { failure: label + ": the registry answered HTTP " + response.status };
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    return { failure: label + ": the registry could not be reached (" + (error && error.message ? error.message : String(error)) + ")" };
  }
  const digest = createHash("sha512").update(bytes).digest("base64");
  if (!verifyIntegrity(pkg.integrity, digest)) {
    return { failure: label + ": the downloaded tarball does not match the sha512 in bun.lock, so it was not unpacked" };
  }
  // The checked bytes go to tar on stdin, never through a temporary file
  // (writing a 13.6 MB tarball to the sandbox's /tmp once failed with EBADF).
  // GNU tar drops the archive's top folder ("package/"); files are owned by
  // the sandbox user, not whatever ids the archive records.
  let why = "";
  for (let attempt = 1; attempt <= UNPACK_TRIES; attempt++) {
    try {
      clearCopy(dir);
      mkdirSync(dir, { recursive: true });
      const tar = spawnSync("tar", ["-xzf", "-", "-C", dir, "--strip-components=1", "--no-same-owner"], { input: bytes, encoding: "utf8" });
      if (!tar.error && tar.status === 0) {
        writeFileSync(marker, pkg.integrity);
        return { downloaded: true };
      }
      why = tar.error ? "tar could not run: " + tar.error.message : "tar exited " + tar.status + (tar.stderr ? ": " + String(tar.stderr).trim().slice(0, 300) : "");
    } catch (error) {
      why = error && error.message ? error.message : String(error);
    }
  }
  try {
    clearCopy(dir);
  } catch {
    // nothing more to undo
  }
  return { failure: label + ": could not be unpacked after " + UNPACK_TRIES + " tries (" + why + ")" };
}

export async function main(cwd, env, platform, arch) {
  const lockPath = join(cwd, "bun.lock");
  if (!existsSync(lockPath)) {
    console.error("verified-install: there is no bun.lock in " + cwd + ", so the pinned packages cannot be checked before installing");
    return 1;
  }
  const parsed = parseLockPackages(readFileSync(lockPath, "utf8"), platform, arch);
  if (parsed.parseError) {
    console.error("verified-install: bun.lock could not be read: " + parsed.parseError);
    return 1;
  }
  if (parsed.missingIntegrity.length > 0) {
    console.error("verified-install: these bun.lock entries have no sha512 to check against, so nothing was installed: " + parsed.missingIntegrity.join(", "));
    return 1;
  }
  const registryBase = (env && env.CADDIE_NPM_REGISTRY) || DEFAULT_REGISTRY;
  const queue = parsed.packages.slice();
  const failures = [];
  let downloaded = 0;
  let already = 0;
  const worker = async () => {
    for (let pkg = queue.shift(); pkg; pkg = queue.shift()) {
      const outcome = await placePackage(cwd, pkg, registryBase);
      if (outcome.failure) failures.push(outcome.failure);
      else if (outcome.already) already++;
      else downloaded++;
    }
  };
  const workers = [];
  for (let i = 0; i < PARALLEL_DOWNLOADS; i++) workers.push(worker());
  await Promise.all(workers);
  if (failures.length > 0) {
    console.error("verified-install: " + failures.length + " package(s) failed, so nothing more was installed:");
    for (const line of failures.sort()) console.error("  - " + line);
    return 1;
  }
  const notes = [];
  if (parsed.leftToBun.length > 0) notes.push(parsed.leftToBun.length + " left to bun");
  if (parsed.otherPlatform.length > 0) notes.push(parsed.otherPlatform.length + " for another platform skipped");
  console.log("verified-install: " + parsed.packages.length + " pinned package(s) match bun.lock (" +
    downloaded + " downloaded and checked, " + already + " already checked)" + (notes.length > 0 ? "; " + notes.join("; ") : ""));
  return 0;
}

if (import.meta.main) process.exit(await main(process.cwd(), process.env, process.platform, process.arch));
`;

/**
 * The frozen install that ends the step: exactly `SCAFFOLD_COMMANDS.install`,
 * so the recipe's meaning (and every verdict built on it) is unchanged. The
 * host uses it both as the operation's final command and as the receipt
 * command it compares against.
 */
export const VERIFIED_INSTALL_COMMAND = SCAFFOLD_COMMANDS.install.join(' && ');

/**
 * The preflight command: write the script into the sandbox, then run it with
 * the sandbox's own `bun`. It does not begin with `bun ` and does not contain
 * the frozen-install text, so command lists elsewhere still see only the real
 * install command.
 */
export function verifiedInstallPreflightCommand(): string {
	return ['set -e', `cat > ${SCRIPT_PATH} <<'${SCRIPT_HEREDOC}'`, VERIFIED_INSTALL_SCRIPT, SCRIPT_HEREDOC, `bun ${SCRIPT_PATH}`].join('\n');
}

export interface VerifiedInstallOptions {
	sessionId: string;
	/** The app's folder in the sandbox (the script reads `bun.lock` from here). */
	cwd: string;
	env?: Record<string, string>;
	/** The caller's operation key; the frozen install's receipt is recorded under it. */
	operationKey: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

/** The default budget for each half: downloading every pinned tarball, then the frozen install. */
export const VERIFIED_INSTALL_TIMEOUT_MS = 600_000;

/**
 * Run the verified install step in a sandbox session:
 *   1. the preflight (download each pinned tarball, check its sha512, unpack it
 *      with GNU tar) under `<operationKey>:verify`;
 *   2. only if that succeeded, the frozen install under the caller's
 *      `operationKey`.
 *
 * A failed preflight is returned as it is and the frozen install never runs
 * (fail closed). On success the result is the frozen install's, with the
 * preflight's summary line first so the activity log shows the check. A
 * replayed call replays the recorded receipts instead of dispatching again,
 * so the resumable paths can call it safely.
 */
export async function runVerifiedInstall(
	driver: Pick<SandboxDriver, 'execute'>,
	options: VerifiedInstallOptions,
): Promise<SandboxExecuteResult> {
	const base = {
		sessionId: options.sessionId,
		timeoutMs: options.timeoutMs ?? VERIFIED_INSTALL_TIMEOUT_MS,
		cwd: options.cwd,
		env: options.env,
		signal: options.signal,
	};
	const preflight = await driver.execute({ ...base, command: verifiedInstallPreflightCommand(), operationKey: `${options.operationKey}:verify` });
	if (preflight.exitCode !== 0) return preflight;
	const install = await driver.execute({ ...base, command: VERIFIED_INSTALL_COMMAND, operationKey: options.operationKey });
	const summary = preflight.stdout.trim();
	return summary ? { ...install, stdout: `${summary}\n${install.stdout}` } : install;
}
