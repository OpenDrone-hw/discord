/**
 * Worker bindings. Secrets are set with `wrangler secret put <NAME>`; vars live
 * in wrangler.toml. Values are never logged.
 */
export interface Env {
  // Secrets
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_OAUTH_CLIENT_ID: string;
  GITHUB_OAUTH_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  /**
   * Shared with the opendrone-web Worker, which signs Early Bird claim tokens
   * with it (linked-roles/early-bird.ts). Unset: /early-bird answers 503.
   */
  EARLY_BIRD_CLAIM_KEY?: string;
  /** Optional secret: "off" stops Discord posting from GitHub events (src/posting.ts). Unset means on. */
  DISCORD_POSTING?: string;

  // D1 database holding linked-role users and their encrypted refresh tokens.
  DB: D1Database;

  // Vars
  GUILD_ID: string;
  APPLICATION_ID: string;
  /** "true" enables /promote. Anything else leaves it disabled. */
  PROMOTE_ENABLED: string;
}

export function promoteEnabled(env: Pick<Env, "PROMOTE_ENABLED">): boolean {
  return env.PROMOTE_ENABLED === "true";
}
