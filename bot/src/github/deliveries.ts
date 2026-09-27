/**
 * Idempotency for GitHub redeliveries.
 *
 * GitHub gives every delivery an X-GitHub-Delivery GUID and keeps it when a
 * delivery is redelivered (Redeliver button or API, possible for 3 days).
 * Each externally visible step of a handler (start a thread, post a
 * card, post a feed line) runs through `once(step)`, keyed on
 * "<delivery>:<step>" in the D1 table github_deliveries:
 *
 * | Row state            | once() does                                         |
 * |----------------------|-----------------------------------------------------|
 * | none                 | claims it (running), runs the step, stores done     |
 * | done                 | skips the step and returns the stored result        |
 * | running, < 60 s old  | skips: another invocation is running it right now   |
 * | running, >= 60 s old | reclaims it: that invocation was cancelled at 30 s  |
 *
 * A step that throws deletes its claim, so a redelivery after a failure runs
 * it again while the steps that succeeded stay skipped. If D1 itself fails,
 * the step runs anyway: a duplicate message beats a lost one. A delivery
 * without the header is not deduplicated.
 *
 * The table is created on first use with CREATE TABLE IF NOT EXISTS (the
 * same statement as TABLE_SQL). Rows older than RETENTION_MS are pruned by
 * the module's scheduled() run.
 */
import { errorText } from "../interactions.ts";

export const RETENTION_MS = 7 * 24 * 3600 * 1000;
export const STALE_CLAIM_MS = 60_000;

export const TABLE_SQL = `CREATE TABLE IF NOT EXISTS github_deliveries (
  key TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL,
  result TEXT,
  updated_at INTEGER NOT NULL
)`;

type Claim = { kind: "claimed" } | { kind: "done"; result: unknown } | { kind: "busy" };

const tableReady = new WeakMap<D1Database, Promise<unknown>>();

export class DeliveryStore {
  readonly #db: D1Database;
  readonly #now: () => number;

  constructor(db: D1Database, now: () => number = () => Date.now()) {
    this.#db = db;
    this.#now = now;
  }

  async #ready(): Promise<void> {
    let ready = tableReady.get(this.#db);
    if (!ready) {
      ready = this.#db.prepare(TABLE_SQL).run();
      tableReady.set(this.#db, ready);
      ready.catch(() => tableReady.delete(this.#db));
    }
    await ready;
  }

  async claim(key: string): Promise<Claim> {
    await this.#ready();
    const now = this.#now();
    const row = await this.#db
      .prepare("SELECT state, result, updated_at FROM github_deliveries WHERE key = ?")
      .bind(key)
      .first<{ state: string; result: string | null; updated_at: number }>();
    if (row?.state === "done") return { kind: "done", result: row.result === null ? undefined : JSON.parse(row.result) };
    if (row && now - Number(row.updated_at) < STALE_CLAIM_MS) return { kind: "busy" };
    const claimed = await this.#db
      .prepare(
        `INSERT INTO github_deliveries (key, state, result, updated_at) VALUES (?, 'running', NULL, ?)
         ON CONFLICT (key) DO UPDATE SET state = 'running', updated_at = excluded.updated_at
         WHERE github_deliveries.state = 'running' AND github_deliveries.updated_at < ?`,
      )
      .bind(key, now, now - STALE_CLAIM_MS)
      .run();
    return (claimed.meta?.changes ?? 0) > 0 ? { kind: "claimed" } : { kind: "busy" };
  }

  async complete(key: string, result: unknown): Promise<void> {
    await this.#db
      .prepare("UPDATE github_deliveries SET state = 'done', result = ?, updated_at = ? WHERE key = ?")
      .bind(result === undefined ? null : JSON.stringify(result), this.#now(), key)
      .run();
  }

  async release(key: string): Promise<void> {
    await this.#db.prepare("DELETE FROM github_deliveries WHERE key = ? AND state = 'running'").bind(key).run();
  }

  /** Deletes rows last touched before now - RETENTION_MS; returns how many. */
  async prune(): Promise<number> {
    await this.#ready();
    const result = await this.#db
      .prepare("DELETE FROM github_deliveries WHERE updated_at < ?")
      .bind(this.#now() - RETENTION_MS)
      .run();
    return result.meta?.changes ?? 0;
  }
}

/** Runs a step at most once per delivery; see the header comment. */
export type Once = <T>(step: string, run: () => Promise<T>) => Promise<T | undefined>;

export function onceFor(store: DeliveryStore | null, delivery: string | null): Once {
  return async <T>(step: string, run: () => Promise<T>): Promise<T | undefined> => {
    if (!store || !delivery) return run();
    const key = `${delivery}:${step}`;
    let claim: Claim;
    try {
      claim = await store.claim(key);
    } catch (error) {
      console.error(`delivery store unavailable for ${key}, running without deduplication:`, errorText(error));
      return run();
    }
    if (claim.kind === "done") return claim.result as T;
    if (claim.kind === "busy") return undefined;
    let result: T;
    try {
      result = await run();
    } catch (error) {
      await store.release(key).catch(() => {});
      throw error;
    }
    await store.complete(key, result).catch((error: unknown) => {
      console.error(`could not record ${key} as done:`, errorText(error));
    });
    return result;
  };
}

/** The store for a Worker's D1 binding, or null when the binding is absent. */
export function storeFor(db: D1Database | undefined): DeliveryStore | null {
  return db && typeof db.prepare === "function" ? new DeliveryStore(db) : null;
}
