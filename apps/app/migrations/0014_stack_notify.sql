-- 0014_stack_notify.sql — "Tell me when it's ready" for build tools (B03).
-- Append-only (P00 numbering). A per-actor subscription for a planned
-- stack; when the stack flips to enabled, each subscriber gets one
-- notification (the semicolon here no longer ends a comment line).

create table if not exists "stack_notify_subscriptions" (
	"actorId" text not null,
	"stackId" text not null,
	"createdAt" text not null,
	primary key ("actorId", "stackId")
);
