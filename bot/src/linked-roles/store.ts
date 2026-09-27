/**
 * D1 access for linked-role users (migrations/0001 and 0002).
 *
 * Refresh tokens are sealed with the "linked-roles refresh tokens v1" key
 * (crypto.ts) before they reach D1 and opened only here. A token that no
 * longer opens (SESSION_SECRET rotated, row edited by hand) reads as null.
 *
 * Concurrency: a refresh holds a lease on its row (refresh_lock_until, see
 * tryLock) so two refreshes of one user never run at the same time, and every
 * refresh write that replaces or clears a token is a compare-and-set against
 * the ciphertext it read (LinkedUser.sealed), so a browser link that lands
 * during a refresh is never overwritten. AES-GCM uses a random IV, so the
 * ciphertext changes on every write even for the same token.
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
  /** Token columns exactly as read (ciphertext or null), for compare-and-set writes. */
  sealed: { discord: string | null; github: string | null };
}

export type TokenChanges = { discordRefreshToken?: string | null; githubRefreshToken?: string | null; githubLogin?: string | null };

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
      sealed: { discord: row.discord_refresh_token, github: row.github_refresh_token },
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
   *
   * With `expected`, the Discord token is written only while the stored
   * ciphertext still equals expected.discord, and the GitHub token and login
   * only while it still equals expected.github (null matches NULL). Returns
   * which groups were written.
   */
  async update(
    discordId: string,
    changes: TokenChanges,
    nowSeconds: number,
    expected?: { discord?: string | null; github?: string | null },
  ): Promise<{ discord: boolean; github: boolean }> {
    const statements: D1PreparedStatement[] = [];
    const wantDiscord = changes.discordRefreshToken !== undefined;
    const wantGitHub = changes.githubRefreshToken !== undefined || changes.githubLogin !== undefined;
    if (wantDiscord) {
      const sealed = await this.#seal(discordId, "discord_refresh_token", changes.discordRefreshToken ?? null);
      statements.push(this.#guarded("discord_refresh_token = ?2", [sealed], "discord_refresh_token", discordId, expected?.discord));
    }
    if (wantGitHub) {
      const sets: string[] = [];
      const values: unknown[] = [];
      if (changes.githubRefreshToken !== undefined) {
        values.push(await this.#seal(discordId, "github_refresh_token", changes.githubRefreshToken));
        sets.push(`github_refresh_token = ?${values.length + 1}`);
      }
      if (changes.githubLogin !== undefined) {
        values.push(changes.githubLogin);
        sets.push(`github_login = ?${values.length + 1}`);
      }
      statements.push(this.#guarded(sets.join(", "), values, "github_refresh_token", discordId, expected?.github));
    }
    statements.push(this.#db.prepare("UPDATE users SET updated_at = ?2 WHERE discord_id = ?1").bind(discordId, nowSeconds));
    const results = await this.#db.batch(statements);
    const changed = (i: number) => Number(results[i]?.meta?.changes ?? 0) > 0;
    return { discord: wantDiscord && changed(0), github: wantGitHub && changed(wantDiscord ? 1 : 0) };
  }

  /** UPDATE users SET <sets> WHERE discord_id = ?1 [AND <column> IS <expected>]. */
  #guarded(
    sets: string,
    values: unknown[],
    column: TokenColumn,
    discordId: string,
    expected: string | null | undefined,
  ): D1PreparedStatement {
    if (expected === undefined) {
      return this.#db.prepare(`UPDATE users SET ${sets} WHERE discord_id = ?1`).bind(discordId, ...values);
    }
    const n = values.length + 2;
    return this.#db
      .prepare(`UPDATE users SET ${sets} WHERE discord_id = ?1 AND ${column} IS ?${n}`)
      .bind(discordId, ...values, expected);
  }

  /**
   * Takes the refresh lease on a user's row until nowSeconds + leaseSeconds.
   * Returns false when another refresh holds an unexpired lease or the row
   * does not exist.
   */
  async tryLock(discordId: string, nowSeconds: number, leaseSeconds: number): Promise<boolean> {
    const result = await this.#db
      .prepare("UPDATE users SET refresh_lock_until = ?2 WHERE discord_id = ?1 AND refresh_lock_until <= ?3")
      .bind(discordId, nowSeconds + leaseSeconds, nowSeconds)
      .run();
    return Number(result.meta?.changes ?? 0) > 0;
  }

  async unlock(discordId: string): Promise<void> {
    await this.#db.prepare("UPDATE users SET refresh_lock_until = 0 WHERE discord_id = ?1").bind(discordId).run();
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
