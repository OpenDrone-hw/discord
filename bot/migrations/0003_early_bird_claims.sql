-- Early Bird claims (src/linked-roles/early-bird.ts). One row per Shopify
-- order: the primary key lets one Discord account claim each paid preorder,
-- and a second account claiming the same order is refused. One Discord
-- account may claim several orders. order_id is the Shopify order GID; no
-- email, name or address is stored.
CREATE TABLE early_bird_claims (
  order_id TEXT PRIMARY KEY NOT NULL,
  order_name TEXT NOT NULL,
  discord_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL -- Unix seconds
);

CREATE INDEX early_bird_claims_discord ON early_bird_claims (discord_id);
