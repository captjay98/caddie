-- A run keeps the environment identity it first took effects in. Rollbacks
-- change the working image; they do not change stack/recipe identity.
create table build_environments (
 runId text primary key, projectId text not null references projects(id),
 stackId text not null, recipeVersion text not null, baseImage text not null,
 createdAt text not null
);
