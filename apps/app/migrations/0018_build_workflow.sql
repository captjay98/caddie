-- Durable project intake, review/resume queue, output and sandbox receipts.
create table build_workflows (
 projectId text primary key references projects(id), runId text not null,
 conversationId text not null, sourceConversationId text,
 intakeKey text unique not null, brief text not null,
 phase text not null check(phase in ('planning','review','building','blocked','ready')),
 planId text, previewId text, pendingKey text, pendingBody text,
 detail text, updatedAt text not null
);
create index build_workflows_source on build_workflows(sourceConversationId);
create table workflow_outputs (
 id text primary key, projectId text not null references projects(id),
 runId text not null, planId text not null, image text not null,
 sha256 text not null references artifact_content(contentHash), createdAt text not null
);
create table sandbox_bindings (
 key text primary key, kind text not null, sessionId text, projectId text,
 runId text, recordJson text not null, updatedAt text not null
);
create index sandbox_bindings_session on sandbox_bindings(sessionId,kind);

create table workflow_resumes (
 id text primary key, projectId text not null references projects(id),
 runId text not null, actorId text not null references user(id),
 afterRoundRowId integer not null, createdAt text not null
);
create index workflow_resumes_run on workflow_resumes(runId);
