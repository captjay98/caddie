-- A delegate's allowance survives process loss and cannot outlive its admission.
create table build_task_deadlines (
 taskKey text primary key, runId text not null, admissionId text not null,
 startedAt integer not null, deadlineAt integer not null
);
