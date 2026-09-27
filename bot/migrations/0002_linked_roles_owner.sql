-- owner: 1 when the storefront has verified that this Discord user owns an
-- OpenDrone product. Nothing in this repository writes it; the linked-roles
-- module only reads it, so the value is 0 for everyone until the storefront
-- integration sets it, and a metadata refresh never overwrites it.
ALTER TABLE users ADD COLUMN owner INTEGER NOT NULL DEFAULT 0;

-- The cron refresh picks the users with the oldest updated_at first.
CREATE INDEX users_updated_at ON users (updated_at);

-- refresh_lock_until: Unix seconds until which one metadata refresh holds this
-- row. A second refresh of the same user waits for it instead of spending the
-- same single-use refresh token. 0 means free; an expired lease counts as free.
ALTER TABLE users ADD COLUMN refresh_lock_until INTEGER NOT NULL DEFAULT 0;
