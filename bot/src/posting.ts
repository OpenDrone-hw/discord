/**
 * Kill switch for Discord posting from GitHub events.
 *
 * | Source                         | Off when                  | Changed by                          |
 * |--------------------------------|---------------------------|-------------------------------------|
 * | Worker secret DISCORD_POSTING  | "off" (any case)          | wrangler secret put / delete        |
 * | D1 bot_settings discord_posting| "off"                     | /posting state:off (admins)         |
 *
 * Posting is on only when neither source says "off"; an unset var and a
 * missing row both mean on. Both are read per request, so a change takes
 * effect on the next delivery without a code deploy. If D1 cannot be read
 * the secret alone decides: it is the switch that does not depend on D1. A
 * secret, not a wrangler.toml var, because `wrangler deploy` keeps secrets
 * but resets vars to wrangler.toml.
 *
 * While off, the GitHub module still answers every delivery with 202, records
 * it as skipped in github_deliveries, keeps its issue to thread map current,
 * and the KiCad collision guard still comments on GitHub; nothing reaches
 * Discord. The linked-role refresh is not posting and keeps running.
 *
 * The table is created on first use, like github_deliveries.
 */
import type { Env } from "./env.ts";
import { errorText } from "./interactions.ts";

export const POSTING_KEY = "discord_posting";

export const SETTINGS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS bot_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
)`;

const tableReady = new WeakMap<D1Database, Promise<unknown>>();

function usable(db: D1Database | undefined): db is D1Database {
  return !!db && typeof db.prepare === "function";
}

async function ready(db: D1Database): Promise<void> {
  let promise = tableReady.get(db);
  if (!promise) {
    promise = db.prepare(SETTINGS_TABLE_SQL).run();
    tableReady.set(db, promise);
    promise.catch(() => tableReady.delete(db));
  }
  await promise;
}

export function varSaysOff(env: Pick<Env, "DISCORD_POSTING">): boolean {
  return (env.DISCORD_POSTING ?? "").trim().toLowerCase() === "off";
}

/** The D1 switch: "on", "off", or null when unset or unreadable. */
export async function storedPosting(db: D1Database | undefined): Promise<"on" | "off" | null> {
  if (!usable(db)) return null;
  try {
    await ready(db);
    const row = await db.prepare("SELECT value FROM bot_settings WHERE key = ?").bind(POSTING_KEY).first<{ value: string }>();
    return row?.value === "off" ? "off" : row?.value === "on" ? "on" : null;
  } catch (error) {
    console.error("bot_settings unreadable; DISCORD_POSTING alone decides:", errorText(error));
    return null;
  }
}

export interface PostingState {
  enabled: boolean;
  /** Value of the DISCORD_POSTING var, or "unset". */
  variable: string;
  /** The D1 switch, or "unset". */
  stored: string;
}

export async function postingState(env: Pick<Env, "DISCORD_POSTING" | "DB">): Promise<PostingState> {
  const stored = await storedPosting(env.DB);
  return {
    enabled: !varSaysOff(env) && stored !== "off",
    variable: env.DISCORD_POSTING?.trim() || "unset",
    stored: stored ?? "unset",
  };
}

export async function postingEnabled(env: Pick<Env, "DISCORD_POSTING" | "DB">): Promise<boolean> {
  return (await postingState(env)).enabled;
}

/** Writes the D1 switch. Throws when D1 is unavailable. */
export async function setStoredPosting(db: D1Database | undefined, value: "on" | "off", by: string, now = Date.now()): Promise<void> {
  if (!usable(db)) throw new Error("the DB binding is missing");
  await ready(db);
  await db
    .prepare(
      `INSERT INTO bot_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .bind(POSTING_KEY, value, by, now)
    .run();
}
