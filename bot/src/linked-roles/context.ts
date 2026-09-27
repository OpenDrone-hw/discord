/**
 * Everything one linked-roles request or cron run needs, built from the
 * per-request Services and the module options. Tests pass `fetch` and `now`;
 * production uses the global fetch and the wall clock.
 */
import { config } from "../config.ts";
import type { FetchLike } from "../discord.ts";
import type { Env } from "../env.ts";
import type { Services } from "../services.ts";
import { deriveKey, SESSION_KEY_INFO, TOKEN_KEY_INFO } from "./crypto.ts";
import { DiscordOAuth, GitHubOAuth } from "./oauth.ts";
import { DEFAULT_MAINTAINER_TEAM, OrgStats } from "./stats.ts";
import { UserStore } from "./store.ts";

/** Users refreshed per cron run: about 7 subrequests each, under the 50 a free-plan invocation allows. */
export const DEFAULT_BATCH_SIZE = 6;
/** A user is refreshed by the cron when their last refresh is older than this. */
export const DEFAULT_STALE_AFTER_SECONDS = 24 * 3600;
/** Refresh lease per user; longer than the 30 s waitUntil budget, so a cancelled refresh frees its row within a minute. */
export const DEFAULT_LOCK_LEASE_SECONDS = 60;
/** How long a refresh waits for another refresh of the same user before giving up with status "busy". */
export const DEFAULT_LOCK_WAIT_MS = 10_000;
export const LOCK_POLL_MS = 250;

export interface LinkedRolesOptions {
  fetch?: FetchLike;
  /** Clock in milliseconds. */
  now?: () => number;
  /** GitHub organisation. Default: config/repos.json `org`. */
  org?: string;
  /** Maintainer team slug. Default: env GITHUB_MAINTAINER_TEAM, else "maintainers". */
  maintainerTeam?: string;
  batchSize?: number;
  staleAfterSeconds?: number;
  lockLeaseSeconds?: number;
  lockWaitMs?: number;
  /** Delay used while waiting for a refresh lease. Default: setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

/** Optional var read by this module; set it in wrangler.toml [vars] to change the team. */
export type LinkedRolesEnv = Env & { GITHUB_MAINTAINER_TEAM?: string };

export class LinkedRolesContext {
  readonly services: Services;
  readonly env: LinkedRolesEnv;
  readonly fetch: FetchLike;
  readonly org: string;
  readonly maintainerTeam: string;
  readonly batchSize: number;
  readonly staleAfterSeconds: number;
  readonly lockLeaseSeconds: number;
  readonly lockWaitMs: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly discord: DiscordOAuth;
  readonly github: GitHubOAuth;
  readonly #now: () => number;
  #store: Promise<UserStore> | undefined;
  #stats: OrgStats | undefined;

  constructor(services: Services, options: LinkedRolesOptions = {}) {
    this.services = services;
    this.env = services.env as LinkedRolesEnv;
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#now = options.now ?? (() => Date.now());
    this.org = options.org ?? config.org;
    this.maintainerTeam = options.maintainerTeam ?? (this.env.GITHUB_MAINTAINER_TEAM || DEFAULT_MAINTAINER_TEAM);
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.staleAfterSeconds = options.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS;
    this.lockLeaseSeconds = options.lockLeaseSeconds ?? DEFAULT_LOCK_LEASE_SECONDS;
    this.lockWaitMs = options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.discord = new DiscordOAuth({
      fetch: this.fetch,
      clientId: this.env.DISCORD_CLIENT_ID,
      clientSecret: this.env.DISCORD_CLIENT_SECRET,
    });
    this.github = new GitHubOAuth({
      fetch: this.fetch,
      clientId: this.env.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: this.env.GITHUB_OAUTH_CLIENT_SECRET,
    });
  }

  nowSeconds(): number {
    return Math.floor(this.#now() / 1000);
  }

  sessionKey(): Promise<CryptoKey> {
    return deriveKey(this.env.SESSION_SECRET, SESSION_KEY_INFO);
  }

  store(): Promise<UserStore> {
    this.#store ??= deriveKey(this.env.SESSION_SECRET, TOKEN_KEY_INFO).then((key) => new UserStore(this.env.DB, key));
    return this.#store;
  }

  /** Created on first use: services.github throws when the App credentials are missing. */
  stats(): OrgStats {
    this.#stats ??= new OrgStats(this.services.github, this.org, this.maintainerTeam);
    return this.#stats;
  }
}
