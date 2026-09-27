/**
 * Offline stand-ins for the github module tests: a D1 database backed by
 * node:sqlite, and one fetch that plays both the Discord and the GitHub API
 * with in-memory state. Every request is recorded.
 */
import { DatabaseSync } from "node:sqlite";
import { Directory, DirectoryCache } from "../../src/config.ts";
import { DiscordClient } from "../../src/discord.ts";
import type { Env } from "../../src/env.ts";
import { GitHubApp } from "../../src/github.ts";
import { createGitHubModule } from "../../src/github/index.ts";
import type { RefreshLinkedUser } from "../../src/github/linked-roles.ts";
import { clearThreadParentCache } from "../../src/github/thread-link.ts";
import { createWorker } from "../../src/index.ts";
import type { Services } from "../../src/services.ts";
import { ChannelType, type Channel } from "../../src/types.ts";
import { BOT_TOKEN, fakeContext, githubSignature, jsonResponse, makeEnv, type RecordedCall } from "../helpers.ts";

export const GUILD = "1494019459822653512";
export const ORG = "OpenDrone-hw";
export const FORUM_RX = "1600000000000000100";
export const TAG_RX = "1600000000000000101";
export const TAG_RX_LITE = "1600000000000000102";
export const TAG_BETA = "1600000000000000103";
export const TAG_PLANNED = "1600000000000000104";
export const FEED = "1600000000000000200";
export const ANNOUNCEMENTS = "1600000000000000300";
export const EXISTING_THREAD = "1600000000000000999";
/** A forum that config/repos.json does not list, e.g. #web-support. */
export const OTHER_FORUM = "1600000000000000400";
export const OTHER_FORUM_THREAD = "1600000000000000401";
/** A development forum assigned to other repositories (config/repos.json "flight-controllers"). */
export const FORUM_FC = "1600000000000000500";
export const FC_THREAD = "1600000000000000501";
export const RULES = "1600000000000000600";

/** D1 over an in-memory SQLite database; implements prepare().bind().run()/first(). */
export function sqliteD1(db = new DatabaseSync(":memory:")): D1Database & { sqlite: DatabaseSync } {
  const statement = (sql: string, args: unknown[]) => ({
    bind: (...values: unknown[]) => statement(sql, values),
    async run() {
      const result = db.prepare(sql).run(...args);
      return { success: true, results: [], meta: { changes: Number(result.changes) } };
    },
    async first<T>() {
      return (db.prepare(sql).get(...args) ?? null) as T | null;
    },
  });
  return { prepare: (sql: string) => statement(sql, []), sqlite: db } as unknown as D1Database & { sqlite: DatabaseSync };
}

/** D1 whose every call fails. */
export function brokenD1(): D1Database {
  const fail = async () => {
    throw new Error("D1_ERROR: database unavailable");
  };
  const statement = { bind: () => statement, run: fail, first: fail };
  return { prepare: () => statement } as unknown as D1Database;
}

let rsaPem: Promise<string> | undefined;

/** A generated App private key (PKCS#8 PEM), shared by the tests in one file. */
export function appPrivateKey(): Promise<string> {
  rsaPem ??= (async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
    let binary = "";
    for (const b of der) binary += String.fromCharCode(b);
    return `-----BEGIN PRIVATE KEY-----\n${btoa(binary).match(/.{1,64}/g)?.join("\n")}\n-----END PRIVATE KEY-----\n`;
  })();
  return rsaPem;
}

export interface FakePull {
  number: number;
  title: string;
  body: string;
  user: { login: string };
  draft: boolean;
  state: string;
  merged: boolean;
  merged_by: { login: string } | null;
  head: { sha: string; ref: string };
  base: { ref: string };
  html_url: string;
  additions: number;
  deletions: number;
  changed_files: number;
}

export interface FakeComment {
  id: number;
  body: string;
  user: { login: string; type: string };
}

export function repoPayload(name = "OpenRX", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    full_name: `${ORG}/${name}`,
    owner: { login: ORG },
    html_url: `https://github.com/${ORG}/${name}`,
    private: false,
    default_branch: "main",
    topics: ["kicad", "status-beta"],
    ...overrides,
  };
}

export function pullJson(repo: string, number: number, overrides: Partial<FakePull> = {}): FakePull {
  return {
    number,
    title: `Change ${number}`,
    body: "",
    user: { login: "alice" },
    draft: false,
    state: "open",
    merged: false,
    merged_by: null,
    head: { sha: `${number}`.padStart(40, "a"), ref: `feature-${number}` },
    base: { ref: "main" },
    html_url: `https://github.com/${ORG}/${repo}/pull/${number}`,
    additions: 10,
    deletions: 2,
    changed_files: 3,
    ...overrides,
  };
}

function forumTags() {
  return [
    { id: TAG_RX, name: "OpenRX", moderated: false },
    { id: TAG_RX_LITE, name: "OpenRX-Lite", moderated: false },
    { id: TAG_BETA, name: "beta", moderated: false },
    { id: TAG_PLANNED, name: "planned", moderated: false },
  ];
}

export class FakeWorld {
  readonly calls: RecordedCall[] = [];
  channels: Channel[] = [
    { id: FORUM_RX, type: ChannelType.GUILD_FORUM, name: "receivers", available_tags: forumTags() },
    { id: FEED, type: ChannelType.GUILD_TEXT, name: "git-feed" },
    { id: ANNOUNCEMENTS, type: ChannelType.GUILD_ANNOUNCEMENT, name: "announcements" },
    { id: RULES, type: ChannelType.GUILD_TEXT, name: "rules" },
    { id: OTHER_FORUM, type: ChannelType.GUILD_FORUM, name: "web-support", available_tags: [] },
    { id: FORUM_FC, type: ChannelType.GUILD_FORUM, name: "flight-controllers", available_tags: [] },
  ];
  /** Threads answered by GET /channels/{id}; guild channel lists do not include them. */
  readonly threadChannels = new Map<string, Channel>([
    [EXISTING_THREAD, { id: EXISTING_THREAD, type: 11, parent_id: FORUM_RX }],
    [OTHER_FORUM_THREAD, { id: OTHER_FORUM_THREAD, type: 11, parent_id: OTHER_FORUM }],
    [FC_THREAD, { id: FC_THREAD, type: 11, parent_id: FORUM_FC }],
  ]);
  /** Messages by channel or thread id. */
  readonly messages = new Map<string, Record<string, unknown>[]>();
  readonly threads: Array<{ id: string; forumId: string; body: Record<string, unknown>; reason: string | undefined }> = [];
  readonly pulls = new Map<string, FakePull>();
  readonly files = new Map<string, string[]>();
  readonly comments = new Map<string, FakeComment[]>();
  /** Thread ids that answer 404 Unknown Channel. */
  readonly goneThreads = new Set<string>();
  /** "METHOD /path" prefixes that fail with 500. */
  readonly failing = new Set<string>();
  /** GitHub logins passed to the linked-role refresh, in order. */
  readonly refreshed: string[] = [];
  #nextId = 1700000000000000000n;
  #nextComment = 1;

  constructor() {
    this.messages.set(EXISTING_THREAD, []);
  }

  #id(): string {
    this.#nextId += 1n;
    return String(this.#nextId);
  }

  addPull(repo: string, pull: FakePull, files: string[] = []): FakePull {
    this.pulls.set(`${repo}#${pull.number}`, pull);
    this.files.set(`${repo}#${pull.number}`, files);
    return pull;
  }

  pull(repo: string, number: number): FakePull {
    const pull = this.pulls.get(`${repo}#${number}`);
    if (!pull) throw new Error(`no fake PR ${repo}#${number}`);
    return pull;
  }

  addComment(repo: string, number: number, body: string, type = "Bot"): void {
    const list = this.comments.get(`${repo}#${number}`) ?? [];
    list.push({ id: this.#nextComment++, body, user: { login: type === "Bot" ? "opendrone[bot]" : "mallory", type } });
    this.comments.set(`${repo}#${number}`, list);
  }

  messagesIn(channelId: string): Record<string, unknown>[] {
    return this.messages.get(channelId) ?? [];
  }

  /** Every Text Display content of a Components V2 message, joined. */
  static text(message: Record<string, unknown> | undefined): string {
    const out: string[] = [];
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (record.type === 10 && typeof record.content === "string") out.push(record.content);
        walk(record.components);
      }
    };
    walk(message?.components);
    return out.join("\n");
  }

  mutations(): RecordedCall[] {
    return this.calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/access_tokens"));
  }

  discordPosts(): RecordedCall[] {
    return this.calls.filter((c) => c.url.startsWith("https://discord.com/") && c.method !== "GET");
  }

  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: RecordedCall = {
      url,
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    this.calls.push(call);
    const parsed = new URL(url);
    const route = `${call.method} ${parsed.pathname}`;
    for (const prefix of this.failing) {
      if (route.startsWith(prefix)) return jsonResponse({ message: "boom" }, 500);
    }
    if (parsed.hostname === "discord.com") return this.#discord(call, parsed);
    if (parsed.hostname === "api.github.com") return this.#github(call, parsed);
    throw new Error(`unexpected host ${parsed.hostname}`);
  };

  #discord(call: RecordedCall, url: URL): Response {
    const path = url.pathname.replace(/^\/api\/v10/, "");
    const body = (call.body ?? {}) as Record<string, unknown>;
    let m: RegExpExecArray | null;
    if (call.method === "GET" && path === `/guilds/${GUILD}/channels`) return jsonResponse(this.channels);
    if (call.method === "GET" && (m = /^\/channels\/(\d+)$/.exec(path))) {
      const id = m[1] as string;
      const channel = this.goneThreads.has(id) ? undefined : (this.threadChannels.get(id) ?? this.channels.find((c) => c.id === id));
      return channel ? jsonResponse(channel) : jsonResponse({ code: 10003, message: "Unknown Channel" }, 404);
    }
    if (call.method === "POST" && (m = /^\/channels\/(\d+)\/threads$/.exec(path))) {
      const id = this.#id();
      this.threads.push({ id, forumId: m[1] as string, body, reason: call.headers["x-audit-log-reason"] });
      this.messages.set(id, [body.message as Record<string, unknown>]);
      this.threadChannels.set(id, { id, type: 11, parent_id: m[1] as string });
      return jsonResponse({ id, type: 11, parent_id: m[1], message: { id } }, 201);
    }
    if (call.method === "POST" && (m = /^\/channels\/(\d+)\/messages$/.exec(path))) {
      const channel = m[1] as string;
      if (this.goneThreads.has(channel)) return jsonResponse({ code: 10003, message: "Unknown Channel" }, 404);
      const list = this.messages.get(channel) ?? [];
      list.push(body);
      this.messages.set(channel, list);
      return jsonResponse({ id: this.#id(), channel_id: channel });
    }
    throw new Error(`unexpected Discord call ${call.method} ${path}`);
  }

  #github(call: RecordedCall, url: URL): Response {
    const path = url.pathname;
    const page = Number(url.searchParams.get("page") ?? "1");
    const perPage = Number(url.searchParams.get("per_page") ?? "30");
    const paged = <T>(items: T[]) => jsonResponse(items.slice((page - 1) * perPage, page * perPage));
    let m: RegExpExecArray | null;
    if (call.method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(path)) {
      return jsonResponse({ token: "ghs_test", expires_at: "2099-01-01T00:00:00Z" }, 201);
    }
    if (call.method === "GET" && (m = /^\/repos\/[^/]+\/([^/]+)\/installation$/.exec(path))) {
      return jsonResponse({ id: 99 });
    }
    if ((m = /^\/repos\/[^/]+\/([^/]+)\/pulls\/(\d+)$/.exec(path))) {
      const pull = this.pulls.get(`${m[1]}#${m[2]}`);
      if (!pull) return jsonResponse({ message: "Not Found" }, 404);
      if (call.method === "GET") return jsonResponse(pull);
      if (call.method === "PATCH") {
        Object.assign(pull, call.body as object);
        return jsonResponse(pull);
      }
    }
    if (call.method === "GET" && (m = /^\/repos\/[^/]+\/([^/]+)\/pulls\/(\d+)\/files$/.exec(path))) {
      const files = this.files.get(`${m[1]}#${m[2]}`) ?? [];
      // "old=>new" stands for a rename.
      return paged(
        files.map((entry) => {
          const [previous, renamed] = entry.split("=>");
          return renamed ? { filename: renamed, previous_filename: previous, status: "renamed" } : { filename: entry, status: "modified" };
        }),
      );
    }
    if (call.method === "GET" && (m = /^\/repos\/[^/]+\/([^/]+)\/pulls$/.exec(path))) {
      const repo = m[1];
      const open = [...this.pulls.entries()]
        .filter(([key, p]) => key.startsWith(`${repo}#`) && p.state === "open")
        .map(([, p]) => p);
      return paged(open);
    }
    if ((m = /^\/repos\/[^/]+\/([^/]+)\/issues\/(\d+)\/comments$/.exec(path))) {
      const key = `${m[1]}#${m[2]}`;
      if (call.method === "GET") return paged(this.comments.get(key) ?? []);
      if (call.method === "POST") {
        this.addComment(m[1] as string, Number(m[2]), (call.body as { body: string }).body);
        return jsonResponse({ id: this.#nextComment }, 201);
      }
    }
    throw new Error(`unexpected GitHub call ${call.method} ${path}`);
  }
}

export interface Harness {
  world: FakeWorld;
  env: Env;
  services: Services;
  /** Signs and sends a delivery through the Worker, then waits for its handlers. */
  deliver(event: string, payload: Record<string, unknown>, delivery?: string): Promise<Response>;
  /** Like deliver, but returns as soon as the Worker answers; handlers may still run. */
  send(event: string, payload: Record<string, unknown>, delivery?: string): Promise<Response>;
  /** Waits for everything passed to waitUntil. */
  settle(): Promise<void>;
}

/**
 * `refresh` replaces refreshLinkedUser; the default records the login in
 * world.refreshed and answers "not-linked".
 */
export async function harness(
  options: { db?: D1Database; world?: FakeWorld; refresh?: RefreshLinkedUser; refreshDeadlineMs?: number } = {},
): Promise<Harness> {
  clearThreadParentCache();
  const world = options.world ?? new FakeWorld();
  const env = makeEnv({ GITHUB_APP_PRIVATE_KEY: await appPrivateKey(), DB: options.db ?? sqliteD1() });
  const discord = new DiscordClient({ token: BOT_TOKEN, fetch: world.fetch });
  const github = new GitHubApp({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY, fetch: world.fetch });
  const directory = new Directory(discord, GUILD, { cache: new DirectoryCache() });
  const context = fakeContext();
  const services: Services = { env, waitUntil: (p) => context.ctx.waitUntil(p), discord, github, directory };
  const refresh: RefreshLinkedUser =
    options.refresh ??
    (async (_services, login) => {
      world.refreshed.push(login);
      return { status: "not-linked", githubLogin: login };
    });
  const module = createGitHubModule({ linkedRoles: { refresh, deadlineMs: options.refreshDeadlineMs } });
  const worker = createWorker({ modules: [module], services: () => services });
  let counter = 0;
  const send: Harness["send"] = async (event, payload, delivery) => {
    const text = JSON.stringify({ installation: { id: 77 }, sender: { login: "alice" }, ...payload });
    const request = new Request("https://bot.example.workers.dev/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": event,
        "X-GitHub-Delivery": delivery ?? `delivery-${++counter}`,
        "X-Hub-Signature-256": await githubSignature(env.GITHUB_WEBHOOK_SECRET, text),
      },
      body: text,
    });
    return worker.fetch!(request as Request<unknown, IncomingRequestCfProperties>, env, context.ctx);
  };
  return {
    world,
    env,
    services,
    send,
    settle: () => context.settle(),
    async deliver(event, payload, delivery) {
      const response = await send(event, payload, delivery);
      await context.settle();
      return response;
    },
  };
}
