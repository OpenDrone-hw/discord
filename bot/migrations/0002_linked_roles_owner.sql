-- owner: 1 when the storefront has verified that this Discord user owns an
-- OpenDrone product. Nothing in this repository writes it; the linked-roles
-- module only reads it, so the value is 0 for everyone until the storefront
-- integration sets it, and a metadata refresh never overwrites it.
ALTER TABLE users ADD COLUMN owner INTEGER NOT NULL DEFAULT 0;

-- The cron refresh picks the users with the oldest updated_at first.
CREATE INDEX users_updated_at ON users (updated_at);
