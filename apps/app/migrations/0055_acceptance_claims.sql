-- At-most-once independent execution across concurrent host retries.
create table feature_acceptance_claims (
 operationKey text primary key, identityHash text not null,
 state text not null check(state in ('executing','settled')), createdAt text not null
);
