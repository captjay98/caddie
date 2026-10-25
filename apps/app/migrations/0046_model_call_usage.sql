-- Per-call observational receipts. Does not reserve/settle money or replace
-- immutable run bindings. NULL usage/cost means unavailable, not zero/free.
create table "model_call_usage" (
 "turnId" text primary key,
 "instanceId" text, "conversationId" text, "submissionId" text,
 "agentName" text, "purpose" text not null,
 "providerId" text not null, "requestedModel" text not null, "responseModel" text,
 "routeId" text, "pricingVersion" text, "currency" text,
 "selectedRole" text, "selectionReason" text not null,
 "inputTokens" integer, "outputTokens" integer, "cacheReadTokens" integer, "cacheWriteTokens" integer, "totalTokens" integer,
 "catalogCostMicros" integer check ("catalogCostMicros" is null or "catalogCostMicros" >= 0),
 "durationMs" real, "isError" integer not null check ("isError" in (0,1)), "createdAt" text not null
);
create index "model_call_usage_instance" on "model_call_usage" ("instanceId", "createdAt");
create index "model_call_usage_submission" on "model_call_usage" ("submissionId", "createdAt");
