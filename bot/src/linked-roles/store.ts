/**
 * D1 access for linked-role users (migrations/0001 and 0002).
 *
 * Refresh tokens are sealed with the "linked-roles refresh tokens v1" key
 * (crypto.ts) before they reach D1 and opened only here. A token that no
 * longer opens (SESSION_SECRET rotated, row edited by hand) reads as null.
 */
import { open, seal } from "./crypto.ts";

export interface LinkedUser {
  discordId: string;
  githubLogin: string | null;
  discordRefreshToken: string | null;
  githubRefreshToken: string | null;
  /** Unix seconds of the last link or refresh attempt. */
  updatedAt: number;
  /** Set by the storefront, never by this module. */
  owner: boolean;
}

interface Row {
  discord_id: string;
  github_login: string | null;
  discord_refresh_token: string | null;
  github_refresh_token: string | null;
  updated_at: number;
  owner: number | null;
}

const COLUMNS = "discord_id, github_login, discord_refresh_token, github_refresh_token, updated_at, owner";

export type TokenColumn = "discord_refresh_token" | "github_refresh_token";

export function tokenContext(discordId: string, column: TokenColumn): string {
  return `${discordId}/${column}`;
}

export class UserStore {
  readonly #db: D1Database;
  readonly #key: CryptoKey;

  constructor(db: D1Database, tokenKey: CryptoKey) {
    this.#db = db;
    this.#key = tokenKey;
  }

  async #seal(discordId: string, column: TokenColumn, token: string | null): Promise<string | null> {
    return token === null ? null : seal(this.#key, token, tokenContext(discordId, column));
  }

  async #open(discordId: string, column: TokenColumn, sealed: string | null): Promise<string | null> {
    return sealed === null ? null : open(this.#key, sealed, tokenContext(discordId, column));
  }

  async #toUser(row: Row): Promise<LinkedUser> {
    return {
      discordId: row.discord_id,
      githubLogin: row.github_login,
      discordRefreshToken: await this.#open(row.discord_id, "discord_refresh_token", row.discord_refresh_token),
      githubRefreshToken: await this.#open(row.discord_id, "github_refresh_token", row.github_refresh_token),
      updatedAt: Number(row.updated_at),
      owner: Number(row.owner ?? 0) === 1,
    };
  }

  async get(discordId: string): Promise<LinkedUser | null> {
    const row = await this.#db.prepare(`SELECT ${COLUMNS} FROM users WHERE discord_id = ?1`).bind(discordId).first<Row>();
    return row ? this.#toUser(row) : null;
  }

  /** GitHub logins are case-insensitive; the column is COLLATE NOCASE. */
  async getByGitHubLogin(login: string): Promise<LinkedUser | null> {
    const row = await this.#db.prepare(`SELECT ${COLUMNS} FROM users WHERE github_login = ?1`).bind(login).first<Row>();
    return row ? this.#toUser(row) : null;
  }

  /** Creates or updates the row after the Discord step. */
  async saveDiscord(discordId: string, refreshToken: string, nowSeconds: number): Promise<void> {
    const sealed = await this.#seal(discordId, "discord_refresh_token", refreshToken);
    await this.#db
      .prepare(
        `INSERT INTO users (discord_id, discord_refresh_token, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (discord_id) DO UPDATE SET
           discord_refresh_token = excluded.discord_refresh_token, updated_at = excluded.updated_at`,
      )
      .bind(discordId, sealed, nowSeconds)
      .run();
  }

  /**
   * Links a GitHub login to a Discord user. A GitHub account links to one
   * Discord account: another row holding the same login loses it, and its
   * updated_at is reset to 0 so the next cron run pushes empty metadata for it.
   * Returns the Discord ids that lost the link.
   */
  async linkGitHub(
    discordId: string,
    login: string,
    refreshToken: string | null,
    nowSeconds: number,
  ): Promise<string[]> {
    const previous = await this.#db
      .prepare("SELECT discord_id FROM users WHERE github_login = ?1 AND discord_id <> ?2")
      .bind(login, discordId)
      .all<{ discord_id: string }>();
    const sealed = await this.#seal(discordId, "github_refresh_token", refreshToken);
    await this.#db.batch([
      this.#db
        .prepare(
          "UPDATE users SET github_login = NULL, github_refresh_token = NULL, updated_at = 0 WHERE github_login = ?1 AND discord_id <> ?2",
        )
        .bind(login, discordId),
      this.#db
        .prepare(
          `INSERT INTO users (discord_id, github_login, github_refresh_token, updated_at) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (discord_id) DO UPDATE SET
             github_login = excluded.github_login,
             github_refresh_token = excluded.github_refresh_token,
             updated_at = excluded.updated_at`,
        )
        .bind(discordId, login, sealed, nowSeconds),
    ]);
    return (previous.results ?? []).map((r) => r.discord_id);
  }

  /**
   * Records the result of a refresh. Fields left undefined keep their value;
   * null clears them. updated_at is always set.
   */
  async update(
    discordId: string,
    changes: { discordRefreshToken?: string | null; githubRefreshToken?: string | null; githubLogin?: string | null },
    nowSeconds: number,
  ): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown) => {
      values.push(value);
      sets.push(`${column} = ?${values.length + 1}`);
    };
    if (changes.discordRefreshToken !== undefined) {
      add("discord_refresh_token", await this.#seal(discordId, "discord_refresh_token", changes.discordRefreshToken));
    }
    if (changes.githubRefreshToken !== undefined) {
      add("github_refresh_token", await this.#seal(discordId, "github_refresh_token", changes.githubRefreshToken));
    }
    if (changes.githubLogin !== undefined) add("github_login", changes.githubLogin);
    add("updated_at", nowSeconds);
    await this.#db
      .prepare(`UPDATE users SET ${sets.join(", ")} WHERE discord_id = ?1`)
      .bind(discordId, ...values)
      .run();
  }

  /** Removes a user who revoked the app on Discord; nothing more can be pushed for them. */
  async delete(discordId: string): Promise<void> {
    await this.#db.prepare("DELETE FROM users WHERE discord_id = ?1").bind(discordId).run();
  }

  /** Users with a Discord refresh token whose updated_at is before `before`, oldest first. */
  async stale(beforeSeconds: number, limit: number): Promise<LinkedUser[]> {
    const result = await this.#db
      .prepare(
        `SELECT ${COLUMNS} FROM users
         WHERE discord_refresh_token IS NOT NULL AND updated_at < ?1
         ORDER BY updated_at, discord_id LIMIT ?2`,
      )
      .bind(beforeSeconds, limit)
      .all<Row>();
    return Promise.all((result.results ?? []).map((row) => this.#toUser(row)));
  }
}
