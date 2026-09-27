/**
 * Offline stand-ins for the linked-roles tests: a D1 database on node:sqlite
 * with the real migrations applied, and one fetch that plays Discord, GitHub
 * OAuth and the GitHub API with in-memory state.
 */
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Directory, DirectoryCache } from "../../src/config.ts";
import { DiscordClient } from "../../src/discord.ts";
import type { Env } from "../../src/env.ts";
import { GitHubApp } from "../../src/github.ts";
import { createWorker } from "../../src/index.ts";
import { createLinkedRolesModule, type LinkedRolesOptions } from "../../src/linked-roles/index.ts";
import { clearInstallationCache } from "../../src/linked-roles/stats.ts";
import type { ServicesFactory } from "../../src/registry.ts";
import type { Services } from "../../src/services.ts";
import { fakeContext, makeEnv } from "../helpers.ts";

// --- D1 ----------------------------------------------------------------------

const MIGRATIONS = new URL("../../migrations/", import.meta.url);

export interface FakeD1 {
  db: D1Database;
  sqlite: DatabaseSync;
  /** Raw row, bypassing the store. */
  row(discordId: string): Record<string, unknown> | undefined;
}

export function fakeD1(): FakeD1 {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
  }
  const plain = (row: Record<string, unknown> | undefined) => (row ? { ...row } : null);
  // D1 accepts numbered parameters (?1, ?2, a number may repeat); node:sqlite
  // binds positional values only to bare "?". Rewrite to bare "?" in order.
  const prepare = (sql: string, params: unknown[]) => {
    const ordered: unknown[] = [];
    let numbered = false;
    const text = sql.replace(/\?(\d+)/g, (_, n: string) => {
      numbered = true;
      ordered.push(params[Number(n) - 1]);
      return "?";
    });
    return { statement: sqlite.prepare(text), values: numbered ? ordered : params };
  };

  class Statement {
    readonly sql: string;
    readonly params: unknown[];
    constructor(sql: string, params: unknown[] = []) {
      this.sql = sql;
      this.params = params;
    }
    bind(...values: unknown[]) {
      for (const v of values) if (v === undefined) throw new Error("D1_TYPE_ERROR: undefined bound");
      return new Statement(this.sql, values);
    }
    async first() {
      const { statement, values } = prepare(this.sql, this.params);
      return plain(statement.get(...values));
    }
    async all() {
      const { statement, values } = prepare(this.sql, this.params);
      const results = statement.all(...values).map((r) => ({ ...r }));
      return { results, success: true, meta: {} };
    }
    async run() {
      const { statement, values } = prepare(this.sql, this.params);
      const r = statement.run(...values);
      return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    }
  }

  const db = {
    prepare: (sql: string) => new Statement(sql),
    async batch(statements: Statement[]) {
      sqlite.exec("BEGIN");
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        sqlite.exec("COMMIT");
        return out;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;

  return {
    db,
    sqlite,
    row: (discordId) => {
      const r = sqlite.prepare("SELECT * FROM users WHERE discord_id = ?").get(discordId);
      return r ? { ...r } : undefined;
    },
  };
}

// --- providers -----------------------------------------------------------------

export interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}

export const ORG = "OpenDrone-hw";
export const INSTALLATION_ID = 99;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let counter = 0;
function token(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${Math.random().toString(36).slice(2)}`;
}

/**
 * In-memory Discord and GitHub. Tokens are opaque strings mapped to users;
 * refresh tokens rotate on use like the real providers.
 */
export class FakeProviders {
  readonly calls: Call[] = [];
  /** "METHOD host/path" keys that answer 500. */
  readonly fail = new Set<string>();

  readonly discordCodes = new Map<string, { id: string; scope?: string; noRefresh?: boolean }>();
  readonly discordRefresh = new Map<string, string>();
  readonly discordAccess = new Map<string, string>();
  readonly roleConnections = new Map<string, Record<string, unknown>>();

  readonly githubCodes = new Map<string, string>();
  readonly githubRefresh = new Map<string, string>();
  readonly githubAccess = new Map<string, string>();
  /** Current login per original login, to simulate renames. */
  readonly renamed = new Map<string, string>();
  readonly mergedPrs = new Map<string, number>();
  readonly orgMembers = new Set<string>();
  readonly teams = new Map<string, Map<string, "active" | "pending">>();

  readonly fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? init.body : "";
    this.calls.push({ method, url, headers, body });
    const key = `${method} ${url.host}${url.pathname}`;
    if (this.fail.has(key)) return json({ message: "boom" }, 500);
    return this.#route(method, url, headers, body);
  };

  callsTo(method: string, hostPath: string): Call[] {
    return this.calls.filter((c) => c.method === method && `${c.url.host}${c.url.pathname}` === hostPath);
  }

  /** Issues a Discord refresh token for a user, as a completed link would have. */
  issueDiscordRefresh(id: string): string {
    const t = token("drt");
    this.discordRefresh.set(t, id);
    return t;
  }

  issueGitHubRefresh(login: string): string {
    const t = token("grt");
    this.githubRefresh.set(t, login);
    return t;
  }

  #bearer(headers: Headers): string | null {
    const auth = headers.get("Authorization") ?? "";
    return auth.startsWith("Bearer ") ? auth.slice(7) : null;
  }

  #discordTokens(id: string, scope = "identify role_connections.write", noRefresh = false) {
    const access = token("dat");
    this.discordAccess.set(access, id);
    const out: Record<string, unknown> = { access_token: access, token_type: "Bearer", expires_in: 604800, scope };
    if (!noRefresh) {
      const refresh = token("drt");
      this.discordRefresh.set(refresh, id);
      out.refresh_token = refresh;
    }
    return out;
  }

  #githubTokens(login: string) {
    const access = token("gat");
    const refresh = token("grt");
    this.githubAccess.set(access, login);
    this.githubRefresh.set(refresh, login);
    return { access_token: access, refresh_token: refresh, expires_in: 28800, token_type: "bearer", scope: "" };
  }

  #login(original: string): string {
    return this.renamed.get(original) ?? original;
  }

  #route(method: string, url: URL, headers: Headers, body: string): Response {
    const path = url.pathname;
    const form = new URLSearchParams(body);

    if (url.host === "discord.com") {
      if (method === "POST" && path === "/api/v10/oauth2/token") {
        if (form.get("client_id") !== "client" || form.get("client_secret") !== "client-secret") {
          return json({ error: "invalid_client" }, 401);
        }
        if (form.get("grant_type") === "authorization_code") {
          const grant = this.discordCodes.get(form.get("code") ?? "");
          if (!grant) return json({ error: "invalid_grant" }, 400);
          this.discordCodes.delete(form.get("code") ?? "");
          return json(this.#discordTokens(grant.id, grant.scope, grant.noRefresh));
        }
        if (form.get("grant_type") === "refresh_token") {
          const old = form.get("refresh_token") ?? "";
          const id = this.discordRefresh.get(old);
          if (!id) return json({ error: "invalid_grant" }, 400);
          this.discordRefresh.delete(old);
          return json(this.#discordTokens(id));
        }
        return json({ error: "unsupported_grant_type" }, 400);
      }
      const id = this.discordAccess.get(this.#bearer(headers) ?? "");
      if (method === "GET" && path === "/api/v10/users/@me") {
        return id ? json({ id, username: `user${id}` }) : json({ message: "401: Unauthorized", code: 0 }, 401);
      }
      const connection = /^\/api\/v10\/users\/@me\/applications\/(\d+)\/role-connection$/.exec(path);
      if (method === "PUT" && connection) {
        if (!id) return json({ message: "401: Unauthorized", code: 0 }, 401);
        const data = JSON.parse(body) as Record<string, unknown>;
        this.roleConnections.set(id, data);
        return json(data);
      }
    }

    if (url.host === "github.com" && method === "POST" && path === "/login/oauth/access_token") {
      if (form.get("client_id") !== "gh-client" || form.get("client_secret") !== "gh-client-secret") {
        return json({ error: "incorrect_client_credentials" });
      }
      if (form.get("grant_type") === "refresh_token") {
        const old = form.get("refresh_token") ?? "";
        const login = this.githubRefresh.get(old);
        if (!login) return json({ error: "bad_refresh_token" });
        this.githubRefresh.delete(old);
        return json(this.#githubTokens(login));
      }
      const login = this.githubCodes.get(form.get("code") ?? "");
      if (!login) return json({ error: "bad_verification_code" });
      this.githubCodes.delete(form.get("code") ?? "");
      return json(this.#githubTokens(login));
    }

    if (url.host === "api.github.com") {
      if (method === "GET" && path === "/user") {
        const login = this.githubAccess.get(this.#bearer(headers) ?? "");
        return login ? json({ login: this.#login(login), id: 1 }) : json({ message: "Bad credentials" }, 401);
      }
      if (method === "GET" && path === `/orgs/${ORG}/installation`) {
        return (this.#bearer(headers) ?? "").split(".").length === 3
          ? json({ id: INSTALLATION_ID })
          : json({ message: "A JSON web token could not be decoded" }, 401);
      }
      if (method === "POST" && path === `/app/installations/${INSTALLATION_ID}/access_tokens`) {
        return json({ token: "ghs_installation", expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
      }
      if (this.#bearer(headers) !== "ghs_installation") return json({ message: "Bad credentials" }, 401);
      if (method === "GET" && path === "/search/issues") {
        const q = url.searchParams.get("q") ?? "";
        const match = new RegExp(`^is:pr is:merged org:${ORG} author:([A-Za-z0-9-]+)$`).exec(q);
        if (!match) return json({ message: "Validation Failed" }, 422);
        return json({ total_count: this.mergedPrs.get(match[1] as string) ?? 0, incomplete_results: false, items: [] });
      }
      const member = new RegExp(`^/orgs/${ORG}/members/([^/]+)$`).exec(path);
      if (method === "GET" && member) {
        return this.orgMembers.has(member[1] as string) ? new Response(null, { status: 204 }) : json({ message: "Not Found" }, 404);
      }
      const team = new RegExp(`^/orgs/${ORG}/teams/([^/]+)/memberships/([^/]+)$`).exec(path);
      if (method === "GET" && team) {
        const state = this.teams.get(team[1] as string)?.get(team[2] as string);
        return state ? json({ state, role: "member" }) : json({ message: "Not Found" }, 404);
      }
    }
    return json({ message: `unexpected ${method} ${url.host}${path}` }, 599);
  }
}

// --- services and worker --------------------------------------------------------

function toPem(label: string, der: Uint8Array): string {
  let binary = "";
  for (const b of der) binary += String.fromCharCode(b);
  const lines = btoa(binary).match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

let appKey: Promise<string> | undefined;

/** One generated RSA key per test file; RSA generation is slow. */
export function appPrivateKey(): Promise<string> {
  appKey ??= (async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    return toPem("PRIVATE KEY", new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer));
  })();
  return appKey;
}

export const BASE = "https://bot.example.workers.dev";
export const APP = "1553748824470851644";

export class Clock {
  ms = Date.UTC(2026, 8, 27, 12, 0, 0);
  now = () => this.ms;
  advance(seconds: number) {
    this.ms += seconds * 1000;
  }
  get seconds() {
    return Math.floor(this.ms / 1000);
  }
}

export interface Harness {
  env: Env;
  d1: FakeD1;
  providers: FakeProviders;
  clock: Clock;
  options: LinkedRolesOptions;
  services: Services;
  call(request: Request): Promise<Response>;
  scheduled(): Promise<void>;
}

export async function harness(
  envOverrides: Partial<Env> & { GITHUB_MAINTAINER_TEAM?: string } = {},
  extraOptions: LinkedRolesOptions = {},
): Promise<Harness> {
  clearInstallationCache();
  const d1 = fakeD1();
  const providers = new FakeProviders();
  const clock = new Clock();
  const privateKey = await appPrivateKey();
  const env = makeEnv({ DB: d1.db, GITHUB_APP_PRIVATE_KEY: privateKey, SESSION_SECRET: "test-session-secret", ...envOverrides });
  const options: LinkedRolesOptions = { fetch: providers.fetch, now: clock.now, ...extraOptions };

  // Bot-token calls must never happen in this module; the bot client fails if used.
  const botFetch = async (): Promise<Response> => {
    throw new Error("linked-roles used the bot client");
  };
  const makeServices: ServicesFactory = (e, waitUntil) => {
    const discord = new DiscordClient({ token: e.DISCORD_BOT_TOKEN, fetch: botFetch });
    const github = new GitHubApp({ appId: e.GITHUB_APP_ID, privateKey: e.GITHUB_APP_PRIVATE_KEY, fetch: providers.fetch });
    return { env: e, waitUntil, discord, github, directory: new Directory(discord, e.GUILD_ID, { cache: new DirectoryCache() }) };
  };
  const worker = createWorker({ modules: [createLinkedRolesModule(options)], services: makeServices });
  const context = fakeContext();
  return {
    env,
    d1,
    providers,
    clock,
    options,
    services: makeServices(env, () => {}),
    call: async (request) => worker.fetch!(request as Request<unknown, IncomingRequestCfProperties>, env, context.ctx),
    async scheduled() {
      await worker.scheduled!({ cron: "17 */6 * * *", scheduledTime: clock.ms, noRetry() {} } as ScheduledController, env, context.ctx);
      await context.settle();
    },
  };
}

/** "name=value" of the Set-Cookie header, for the next request's Cookie header. */
export function cookieFrom(response: Response): string {
  const header = response.headers.get("Set-Cookie") ?? "";
  return header.split(";")[0] ?? "";
}

export function get(path: string, cookie?: string): Request {
  return new Request(`${BASE}${path}`, cookie ? { headers: { Cookie: cookie } } : {});
}

/**
 * Runs the whole browser flow for one Discord user and GitHub login and
 * returns the final response.
 */
export async function link(h: Harness, discordId: string, login: string): Promise<Response> {
  const start = await h.call(get("/linked-roles"));
  const state1 = new URL(start.headers.get("Location") ?? "").searchParams.get("state") ?? "";
  const dcode = `dcode-${discordId}-${login}`;
  h.providers.discordCodes.set(dcode, { id: discordId });
  const afterDiscord = await h.call(
    get(`/linked-roles/discord/callback?code=${dcode}&state=${state1}`, cookieFrom(start)),
  );
  const state2 = new URL(afterDiscord.headers.get("Location") ?? "").searchParams.get("state") ?? "";
  const gcode = `gcode-${discordId}-${login}`;
  h.providers.githubCodes.set(gcode, login);
  return h.call(get(`/linked-roles/github/callback?code=${gcode}&state=${state2}`, cookieFrom(afterDiscord)));
}
