# Flue runtime contract lessons (pin: 2.2.2)

Paid for in iterations during the Nebius-forge evaluation and adjudication
(`/Users/captjay98/projects/nebius-forge-eval/adjudication/`). Read before
writing agent code; re-verify every item on any version bump. Exact installed
versions live in `bun.lock` / `apps/app/package.json`.

## Pinned versions (P00 baseline)

| Package | Version |
|---|---|
| `@flue/runtime` | 2.2.2 (exact) |
| `@flue/cli` | 2.2.2 (exact) |
| `@flue/vite` | 2.2.2 (exact) |
| `@flue/react` | 2.2.2 (exact) |
| `@flue/sdk` | 2.2.2 (exact) |
| `@earendil-works/pi-ai` | 0.87.1 (evaluated; needed for custom providers — add in P05) |
| `@cloudflare/vite-plugin` | 1.39.2 (exact — newer minors break preview; see toolchain notes) |
| `vite` | 8.0.14 (exact) |
| `wrangler` | 4.113.0 (exact) |

Do not widen these ranges casually; Flue is young and API drift is the
documented maintenance tax.

## Authoring agents

- Agents are TypeScript functions. A module whose **first line is
  `'use agent'`** exports agents; every exported capitalized function is one,
  and the function name is its durable identity. The return value is the
  system prompt.
- Tool schemas use **Valibot** (not zod, not JSON Schema).
- Tools implement **`run(ctx)`** with the input under **`ctx.data`** and the
  `{ output }` envelope as the return.
- **Subagent renders reject `useModel`/`usePersistentState`** — the model
  goes on the `useSubagent()` definition; state passes through the task
  prompt.
- **`useAgentFinish`** is the completion enforcement hook: wire it so an
  unfinished run cannot be reported complete (adjudication observed a blocked
  coordinator turn an honest FAILED settlement through this gate).
- Approval/design gates belong in the write path as durable records checked
  before effects — conversational continuity alone is not authorization.

## Providers

- `flue.config.ts` `providers` takes **built-in provider IDs**, not paths.
  Custom provider registration belongs in **`src/app.ts`** via
  `setProvider(...)` (the runtime's documented precedence point).
- pi-ai lazy imports are **extensionless** (e.g.
  `@earendil-works/pi-ai/api/openai-completions.lazy`).
- Nebius Token Factory requires the compat block:
  `supportsDeveloperRole: false`, `supportsStore: false`,
  `maxTokensField: 'max_tokens'` — TF 422s the OpenAI `developer` role.
  Reference construction (model route + pricing fields) is in the
  adjudication evidence; port into `src/agents/providers.ts` in P05.

## Cloudflare target

- `npx @flue/cli@<pin> init --target cloudflare` generates: `flue.config.ts`,
  `src/app.ts` (route map — every route mounted explicitly),
  `src/cloudflare.ts` (Worker-level exports; **never a `fetch`**), agent
  modules, `vite.config.ts` (`flue()` before `cloudflare({config:
  flueWorkerConfig()})`), `wrangler.jsonc`.
- Every agent identity generates a **Durable Object class `Flue<Name>Agent`**
  and needs a wrangler **migration entry**; migrations are append-only —
  append a new `{tag, new_sqlite_classes}` entry per added agent.
- `src/cloudflare.ts` named exports collide with generated classes → rename
  error at build; its default export must be an object of non-HTTP handlers.
- The generated Worker entry calls **your Hono `app.fetch(request, env,
  ctx)`** — one fetch entry; application routes and agents compose there.
- The flue vite plugin adds CORS-ish headers
  (`Access-Control-Allow-Credentials`, `Access-Control-Expose-Headers:
  Stream-Next-Offset, Stream-Up-To-Date, Location`) to responses; harmless,
  expected.
- `flueWorkerConfig()` must be called after `flue()` in the same vite config;
  the sibling plugin owns the wrangler config end to end.

## Static assets composition (P00-established)

- Static assets are plain wrangler `assets` config, honored through the vite
  build: `directory`, `binding`, `not_found_handling`, `run_worker_first`
  pass through to the generated `dist/<name>/wrangler.json`.
- `run_worker_first` as an array keeps `/api`, `/agents`, `/app` in the
  Worker (JSON 404s, SPA fallback) while the landing tree serves directly.
- Hono gotcha: a **mounted sub-app's `.notFound()` does not fire** for
  unmatched paths under its mount — handle the JSON 404 on the parent app.
- `vite build` outputs the worker to `dist/<name>/` and the client to
  `dist/client/`; `bun run compose:assets` merges the Astro landing + SPA
  (collision-checked, manifest at `apps/app/dist/composition-manifest.json`).
- `vite preview` runs the real workerd locally — use it as the routing test
  harness (no deploy). Known limit (flue 2.2.2): agent **dispatch** through
  the DO router under `vite preview` fails with
  `TypeError: this.runtime.startActiveSpan is not a function` — mounting and
  route composition are provable there (non-404 + structured Flue error
  body), but agents do not actually execute. Execute agents via
  `bunx flue run <module> --message ...` or `bun run dev`; P05 must not
  classify preview-harness agent responses as run evidence.

## @flue/react transport (adopt in P06)

- `useFlueAgent({ url })` → `messages` (typed parts: text / reasoning /
  `data-*` / `dynamic-tool` / file), `status`
  (idle|connecting|submitted|streaming|error), `historyReady`, `error`,
  `failedSends` (retained optimistic messages with retry),
  `settlements` (submissionId → outcome), `refresh()`.
- `sendMessage(message: string, options?)` takes a **plain string** —
  passing a message object 400s (`invalid_request`). Options pass through
  idempotencyKey / initialData / uid / signal / images / documents.
- Tool-banner grammar maps 1:1 onto `dynamic-tool` part states
  (queued → working → output-available | output-error).

## Sandbox/runtime behavior (for P03/P04/P05 design)

- Crash recovery in the DO mode is real: `onStart` → drain unsettled
  submissions (30s lease + 15s scan, same-submissionId replacement) — zero
  application recovery code, LIVE VERIFIED after whole-runtime SIGKILL.
- Cross-process abort intent (`abort_requested_at`) is durable and enforced;
  observed 5.3–6.6s to terminal-aborted with resurrection blocked. In-flight
  tool cancellation propagates a signal to async adapters.
- Neither Flue nor any framework gives exactly-once external effects:
  interrupted remote work re-runs; keyed/idempotent reconciliation is
  application policy (P03).
- Model coordinators degrade into hallucinated progress when tools are
  blocked — budget caps + completion gates + machine-checked acceptance are
  mandatory (observed live, twice).

## Toolchain notes (local verification)

- `bun test` sets no working directory magic: spawn `vite preview` with an
  explicit `cwd`; preview binds `localhost` (IPv6) by default — pass
  `--host 127.0.0.1` when the harness fetches IPv4.
- `Bun.pid` is `undefined` under `bun test` (bun 1.4.0) — use `process.pid`.
- bun test kills dangling spawned children at exit via the process group —
  do not put the server in the test's group expectation path; clean up by
  **listening** socket (`lsof -ti -sTCP:LISTEN tcp:PORT`; without `-sTCP:
  LISTEN` lsof also returns the test's own client sockets and you kill the
  runner).
- Hono sub-app `notFound` does not fire on mounts (see above); valibot
  schemas have no `.parse` methods — use standalone `v.parse(schema, value)`;
  `v.isoTimestamp()` accepts millisecond-precision UTC, `v.isoDateTime()`
  does not.

## DO identity / bootstrap: the stale-alarm wedge (2026-10-23)

**Symptom.** A project's workflow sat in `planning` with `planId = null`; the
UI showed "Caddie is turning your request into a plan" indefinitely. The local
server logged, on every `/experience` poll (~every 3 s):

```
[flue] agent "Coordinator" instance "conv_…" conversation read failed across the DO boundary
  caused by: Attempting to read .name on FlueCoordinatorAgent, but this.ctx.id.name
  is not set and no __ps_name fallback record is available. … If this happens in an
  alarm handler firing on a stale alarm record, initialize the DO from a fetch/RPC
  entry point first so PartyServer can persist the fallback name.
```

**Root cause (traced, not guessed).** The coordinator DO is a PartyServer/Flue
`Server`. Its name resolves from `ctx.id.name` (populated when addressed via
`idFromName`/`getByName`) or, as a fallback, a `__ps_name` storage record that
`#ensureInitialized()` writes the first time the DO starts with a name present.
An **alarm** has no request and no header; on current workerd it still sees
`ctx.id.name`, but an alarm record written by an **older workerd that did not
persist `name` into the alarm record** fires with `ctx.id.name` undefined. If
`__ps_name` was never committed (the DO never completed a named init), the SDK's
`.name` getter throws inside the alarm handler. The DO is then wedged:
`getServerByName` → `retryDurableObjectOperation` → `.name` keeps throwing, so
every conversation read AND every delivery across the DO boundary fails. The
parked planning intake (`build_workflows.pendingKey`) never runs; the
`/experience` recovery poll re-delivers every lease but hits the same wedge.

**Why caddie cannot reach the DO directly.** Only `PREVIEW_DB` is bound as a DO
namespace (`wrangler.jsonc`). `FlueCoordinatorAgent` is declared in migrations
but has no env binding — the only path to it is the HTTP route
`/agents/coordinator/:conversationId` (Flue's `createAgentRouter`). So the fix
and any recovery must go through that route.

**Fix (defence-in-depth, name-based addressing preserved).** The browser's Flue
client sends PartyServer's `x-partykit-room` header via its PartySocket; our
SERVER self-fetch (`workerSelfDeliver` / `workerSelfAbort` in
`server/workflow-dispatch.ts`) did not. We now send it
(`coordinatorRoomHeader`). The DO can then resolve its name on the fetch path
even when `ctx.id.name` is momentarily unavailable (SDK reads the header into
`#_name`), so `#ensureInitialized()` completes and COMMITS `__ps_name` — the
fallback a later cold alarm recovers from. The route still resolves via
`getServerByName`/`idFromName`; the header is belt-and-braces.

**UI surfaces the failure.** `workflowSnapshot` now returns `dispatchStalled`
(`build-workflow.ts/planningDispatchStalled`): true only when a `planning`
phase's parked handoff is `reconciliation-required`/failed/cancel* AND older
than one redelivery lease (so an in-flight retry never flashes an error). The
plan view (`ProjectWorkflow.tsx`) then shows an actionable Retry — which
re-polls and re-runs server recovery with the SAME idempotency key, so a retry
can never start a second plan or charge — instead of the endless placeholder.

**Recovery of a wedged DO (data-preserving).** Restart the worker process to
drop the in-memory wedged instance; the next named fetch runs `setName()` in
`blockConcurrencyWhile` and commits `__ps_name` BEFORE the stale alarm handler
runs, so the alarm then recovers its name and the DO drains the parked intake.
This is the SDK's own documented remedy ("initialize the DO from a fetch/RPC
entry point first"), NOT a state wipe: the project, run, conversation and the
parked `pendingKey` are untouched, and the idempotency key means no duplicate
submission or charge. In production (no process restart), the committed
`__ps_name` from a normal named fetch prevents the wedge from forming.

**Evidence classification.**
- LOCAL VERIFIED: the single stuck project recovered on this dev instance after
  the restart (`phase: planning→review`, `planId` became a real `pdr_…`,
  `pendingKey` cleared, zero identity errors after). Regression tests
  (`workflow-dispatch.test.ts` x-partykit-room on self-deliver/abort;
  `build-workflow.test.ts` dispatchStalled true-after-lease / false-in-flight /
  false-no-op) pass under `bun test`.
- NOT live-verified here: the production coordinator DO was not exercised (no
  deploy was part of this fix). The production argument is by construction (the
  header makes every server fetch persist `__ps_name`), not by a live receipt.
- Migrations 0040–0043 were applied to the LOCAL D1 only
  (`wrangler d1 migrations apply caddie --local`), preserving existing data; the
  running instance had been at 0039.
