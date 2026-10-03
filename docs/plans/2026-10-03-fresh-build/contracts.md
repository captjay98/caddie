# Boundary contracts and acceptance examples

Proposed TypeScript shapes, not implemented Flue APIs. Integration lead freezes them in P00; use actual installed runtime types at the adapter edge. Avoid making these a generic enterprise framework.

## Scope, authorization and run identity

```ts
type Scope = Readonly<{
  actorId: string;
  workspaceId: string;
  projectId: string;
}>;
type RunBinding = Readonly<{
  runId: string;
  projectId: string;
  conversationId: string;
  submissionId: string;
  planRevision: string;
  stackId: StackId;
  payerId: string;
  modelRouteId: string;
  pricingVersion: string;
}>;
type StackId = 'react-hono' | 'tanstack-start' | 'laravel-inertia'
  | 'fastapi-react' | 'flutter';
```

Create Scope from verified session+membership, never body/model supplied actor ID. Reauthorize each HTTP/stream/asset operation; agent identity is derived server-side from project binding. Cancellation or loss of membership revokes future effects. DO IDs are routing identifiers, not authorization secrets. Disconnect active streams on revocation or use short-lived revalidated authorization with documented bound.

D1 is authoritative for project, permission, artifact, approval and financial business records; Flue DO storage is authoritative for agent execution state. Bridge through stable IDs, idempotent transitions and receipts; do not assume a D1+DO distributed transaction. Prepare run binding/reservation, dispatch with stable idempotency key, reconcile dispatch receipt after crash. Never report a run started without durable identity.

## Approval and effect

```ts
type ApprovalIntent = {
  projectId: string;
  action: 'design' | 'feature-review' | 'deploy-production'
    | 'destructive-database-change' | 'merge-default-branch';
  resourceId: string;
  revisionHash: string;
  policyVersion: string;
};
type ApprovalRecord = ApprovalIntent & {
  id: string; intentHash: string; decidedBy: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'revoked' | 'expired' | 'superseded';
  expiresAt: string;
};
type ExternalOperation = {
  id: string; projectId: string; runId: string; operationKey: string;
  provider: string; remoteId: string | null;
  status: 'prepared' | 'dispatched' | 'succeeded' | 'failed'
    | 'cancel-requested' | 'cancelled' | 'reconciliation-required';
  receiptId: string | null;
};
```

Intent hash uses canonical serialized exact action/resource/revision, with policy version. API only accepts authenticated owner decisions. Review mode adds feature gates; autonomous mode skips only those discretionary gates. Agent tools cannot approve their own plan. Agent-readable mirror files are convenience only. Capability grants and bounded test environment operations can be covered by existing explicit authorization; avoid prompting for every reversible step.

External-effect idempotency key is durable and unique for the logical action/revision; it is not attempt ID. Unique DB insertion elects a dispatcher, and provider identity enables reconciliation. Uncertain dispatch cannot be retried blindly, even when remote ID was lost; support provider correlation lookup or stop for reconciliation. Local negative tests must prove no provider invocation on denied intent.

```ts
it('does not execute a stale approved revision', async () => {
  const approval = await fixture.approveAsOwner({ revision: 'v1' });
  await fixture.revisePlan('v2');
  await expect(fixture.deploy({ approvalId: approval.id }))
    .rejects.toMatchObject({ code: 'STALE_APPROVAL' });
  expect(fixture.provider.calls).toHaveLength(0);
});
```

Fixture API above must be implemented in tests; do not build production APIs merely to mimic this snippet. Add wrong user/project, expiry at execution, duplicate clicks, changed target resource, revoked installation and stale run tests.

## Budget

Store integers in a declared money subunit, no floating-point money; pricing tables are versioned. Before provider call atomically reserve a conservative bound for inference and sandbox/preview resources using immutable payer/model/key-reference binding. Unknown price cannot execute on a capped account. Record billed/estimated/unknown usage distinctly. Idempotent settle reconciles provider usage; cancellation does not release unresolved liability.

```ts
it('caps concurrent reservations across independent callers', async () => {
  await dbFixture.setBudget({ payerId: 'p1', limit: 100 });
  const results = await Promise.allSettled([
    clientA.reserve({ payerId: 'p1', key: 'op-a', amount: 70 }),
    clientB.reserve({ payerId: 'p1', key: 'op-b', amount: 70 }),
  ]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(await dbFixture.reserved('p1')).toBe(70);
});
```

Run this against real local D1/workerd concurrency, not a shared JS map. If payer DO serialization is necessary, it becomes the single reserve authority, with journaled D1 projection/reconciliation; do not let both stores independently authorize spend. BYOK inference still needs execution quotas and platform-paid sandbox accounting. Keys use authenticated storage, encryption and rotation; only adapter receives secret values.

## Sandbox and verification

```ts
interface SandboxDriver {
  create(input: { projectId: string; runId: string; image: string }): Promise<{ sessionId: string }>;
  execute(input: { sessionId: string; command: string; operationKey: string;
    timeoutMs: number; signal?: AbortSignal }): Promise<{ remoteId: string }>;
  status(remoteId: string): Promise<{ state: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'; exitCode?: number }>;
  cancel(remoteId: string): Promise<{ requested: boolean }>;
  export(sessionId: string): Promise<{ artifactRef: string; sha256: string }>;
  dispose(sessionId: string): Promise<void>;
}
```

Complete implementation also needs bounded upload/download and checkpoint/restore. A cancellation request is not confirmed termination. UI may show agent stopped while cleanup is still pending; financial reconciliation remains open. Workers adapter must persist remote identity and poll until known terminal outcome or explicitly report uncertainty.

Protected acceptance fixture is inaccessible to generated-code writes; validate manifest hashes before and after. Test process must not allow candidate changes to runner/config/dependencies to substitute the evaluator. For imported apps, original tests are preserved; new acceptance harness is separately maintained. Record source SHA, commands/exit codes, environment/image digest and actual browser assertions. QA cannot mark success based only on model testimony or a screenshot.

Build completion requires artifact-bound acceptance on the final revision; later file modifications invalidate it. Last green revision remains available after failed repair, but must not be presented as containing unverified changes.

## Stack recipe

```ts
type StackRecipe = {
  id: StackId; version: string; imageDigest: string;
  install: string[]; test: string[]; build: string[];
  start: string[]; requiredCapabilities: string[];
  artifacts: string[];
  preview: 'static' | 'server' | 'android-emulator';
  availability: 'unverified' | 'verified' | 'blocked';
};
```

Recipe commands are curated, not model-supplied host commands. Generated app code executes only in isolated environment. Flutter defaults to proven Hono backend; alternative backend pairings get explicit contract test. Per-stack delivery first means source/setup plus private preview (or APK/emulator), not automatic arbitrary production deployment. Production target adapters require separate explicit approval and target-specific verification; Caddie's Workers host does not imply Laravel/Python/Android can deploy there.

## UI and evidence

```ts
type DecisionCard = {
  id: string; projectId: string; runId?: string;
  kind: 'approval' | 'change' | 'deadline' | 'result';
  headline: string; summary: string; evidenceIds: string[];
  status: 'needs-you' | 'changed' | 'handled' | 'blocked';
  updatedAt: string;
  primaryAction: { label: string; kind: 'review' | 'inspect' | 'preview'; targetId: string };
};
```

Actions resolve server-side authorized IDs. Tool output text is not an executable UI action. Transport idle does not mean business complete. Preserve drafts on errors, avoid stale cache across account/project changes, group completed history without disabling inspection.

Claims store snapshot ID/hash, quote/locator, source authority, original/processed provenance and extraction version. A confidence number is not truth. Missing timezone/time remains unknown. Profile memory must never overrule source restrictions or authorize effects.
