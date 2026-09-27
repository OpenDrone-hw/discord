-- Linked-role users. One row per Discord user who completed the linked-role
-- flow. Refresh tokens are stored only as ciphertext (encrypted with a key
-- derived from the SESSION_SECRET Worker secret), never in plaintext, so the
-- bot can push fresh role connection metadata without the user returning.
CREATE TABLE users (
  discord_id TEXT PRIMARY KEY NOT NULL,
  github_login TEXT COLLATE NOCASE,
  discord_refresh_token TEXT,
  github_refresh_token TEXT,
  updated_at INTEGER NOT NULL -- Unix seconds
);

-- One Discord account per GitHub account; GitHub logins are case-insensitive.
CREATE UNIQUE INDEX users_github_login ON users (github_login) WHERE github_login IS NOT NULL;
