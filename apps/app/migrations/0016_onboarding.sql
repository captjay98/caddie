-- Explicit account onboarding state; existing accounts without a record see welcome once.
CREATE TABLE user_onboarding (
 userId TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
 completedAt TEXT NOT NULL
);
