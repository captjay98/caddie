# Farmhand saved-version reconciliation — 27 October 2026

**Evidence:** LOCAL VERIFIED by read-only queries against the local D1 state;
no project data, code versions or workflow state were modified. This is not a
browser or provider acceptance result and does not establish deployment.

At inspection the Farmhand workflow was `ready`, pointing at output
`out_569b92660bada2b7cf0185a117279cfd`. The code-version table associated it
with commit `56ae4b44b3de377111b3d6e2757eb978da155084`, 55 files and 414,138
bytes. The baseline was commit `08b683cdf6c93fbd8541d88a39e6ed2aaf79fee1`,
55 files and 414,129 bytes, pointing at
`out_02c537b50b9e95f636b28c27b10b73d9`.

The content-addressed file manifests differed only for `src/App.tsx`. Comparing
the stored file bytes showed one change: the empty-state heading changed from
“No cycles yet” to “Your farm starts here”. The baseline diagnosis of the
stock navigation, medication dependency, feed estimate and triage limitations
therefore remains relevant to this saved version. This does not rule out an
unfinished or unsaved sandbox attempt; it does mean the current saved preview
is not evidence that those fixes were delivered.

The release packet's claim of a second, checked demo-spine repair needs an
output/version identifier and independent journey evidence before it can be
accepted. Livestock's workflow also reported `ready`; this inspection did not
test that app.

## Submission deadline source

**LIVE VERIFIED (public source read only) / LOCAL VERIFIED (stored evidence
inspection).** On 27 October, the
[official Nebius x NVIDIA rules](https://nebiusglobalaihackathon.devpost.com/rules)
state a submission close of 30 October 2026 at 10:00 a.m. Pacific (PDT),
which is 6:00 p.m. in Africa/Lagos. The read-only local D1 snapshot had no
project deadline milestone or Nebius submission-deadline claim. The app
therefore cannot yet show that time as its own source-backed fact. The local
implementation now supports a fresh, literal, matching and unambiguous rules
claim, and converts it to the user's configured timezone; it also requires a
current successful rules read within 24 hours and refuses competing
authoritative readings. Synthetic SQLite tests verify that path and the exact
closing transition on project list and header. Until the correct source is ingested and linked, the
date-only presentation continues to say the time is not confirmed. This observation does not
modify the project, assert the rules will never change, or verify deployment.

## Additional saved-source risks

**LOCAL VERIFIED, isolated generated-app test:** the saved `src/server.ts`
does not mount its sign-in helper or require a user for `/api/farms`. An
unauthenticated test caller successfully created a synthetic farm (HTTP 201)
and read it back (HTTP 200) with the app's local D1 test environment. Its
server creates a fixed demo owner and lists all farms without an actor filter.
This does not test the deployed app, but it is a publication blocker for this
saved version until authentication and ownership are implemented and tested
across separate users and direct API requests.

The reproduction loaded the exact saved source into a temporary directory,
installed its already-cached dependencies offline and exercised its own
in-memory D1 test environment. No credentials, local project data or paid
services were used:

```ts
const env = createTestEnv();
const created = await app.request('/api/farms', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Synthetic farm', location: 'Test location' }),
}, env);
expect(created.status).toBe(201); // no sign-in or authorization header
expect((await app.request('/api/farms', {}, env)).status).toBe(200);
```

**LOCAL VERIFIED (source inspection); SIMULATED (UI fault injection).**
The current saved `src/App.tsx` sends the medication log and the stock update
as separate concurrent HTTP requests. If one succeeds and the other fails, the
record and stock can disagree; the client computes the replacement stock from
its previously loaded value, so concurrent edits can overwrite one another.
An isolated API test also confirmed that updating a synthetic medicine item
from quantity 3 to quantity -2 succeeds with HTTP 200; the server does not
enforce a nonnegative balance.
The same pattern sends a mortality log and a replacement cycle count in two
requests. Do not describe either workflow as transactionally reliable from a
successful single-user happy path.

In a test of the saved React component with a mocked network, a successful
mortality-log response followed by a failed cycle-update response left the
saved log present while the displayed count stayed at 100. This demonstrates
the partial-failure path in a simulation, not a fault injected into the real
preview or evidence that an active user's data was affected.

```ts
await Promise.all([
  fetchOk('/api/logs', { method: 'POST', body: /* medication record */ }),
  fetchOk(`/api/inventory/${item.id}`, { method: 'PATCH', body: /* new quantity */ }),
]);
```

When the real app is repaired, make each business operation a single server
transaction with replay-safe operation identity, scoped authorization,
quantity and unit checks, and an explicit conflict/insufficient-stock result.
Fault-inject failures and concurrent/replayed submissions; verify both records
and stock or count across reload and offline recovery. This evidence identifies
a possible inconsistency from source structure; it does not claim a particular
failure was observed in the active preview.
