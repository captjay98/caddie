-- Host-owned acceptance results, immutable per checked operation and revision.
create table feature_acceptance_receipts (
 operationKey text primary key, projectId text not null references projects(id),
 runId text not null, admissionId text not null, planId text not null,
 designId text not null, featureId text not null, checkedImage text not null,
 status text not null check(status in ('passed','failed','not-checked')),
 evidenceJson text not null, createdAt text not null
);
