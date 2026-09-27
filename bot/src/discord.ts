/**
 * Discord REST client.
 *
 * - Bot token auth, except on token routes (interaction callbacks, webhook
 *   execution) that authenticate through the URL.
 * - Rate limits: tracks X-RateLimit-* per bucket and waits before a request
 *   into an exhausted bucket; on 429 waits retry_after and retries, up to
 *   maxRetries. A wait longer than maxWaitMs throws RateLimitError instead of
 *   holding the Worker.
 * - Mentions: every message body sent through this client gets
 *   allowed_mentions {parse: []} unless the caller set allowed_mentions
 *   explicitly. Text built from GitHub or user input must never ping anyone;
 *   to ping a role on purpose pass allowed_mentions {roles: [id]}.
 * - Errors never contain the token: token route segments are redacted.
 */
import type {
  AllowedMentions,
  ApplicationCommandDefinition,
  Channel,
  InteractionResponse,
  MessagePayload,
  Role,
  RoleConnectionMetadata,
} from "./types.ts";

export const API_BASE = "https://discord.com/api/v10";
export const USER_AGENT = "DiscordBot (https://github.com/OpenDrone-hw/discord, 0.1.0)";
export const DEFAULT_AUDIT_REASON = "OpenDrone-hw/discord bot";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function noMentions(): AllowedMentions {
  return { parse: [] };
}

export class DiscordError extends Error {
  readonly status: number;
  readonly code: number | undefined;
  readonly route: string;
  readonly body: unknown;

  constructor(status: number, route: string, body: unknown) {
    const code = isRecord(body) && typeof body.code === "number" ? body.code : undefined;
    const detail = isRecord(body) && typeof body.message === "string" ? `: ${body.message}` : "";
    super(`Discord ${route} failed with ${status}${code !== undefined ? ` (code ${code})` : ""}${detail}`);
    this.name = "DiscordError";
    this.status = status;
    this.code = code;
    this.route = route;
    this.body = body;
  }
}

export class RateLimitError extends DiscordError {
  readonly retryAfterMs: number;

  constructor(route: string, retryAfterMs: number, body: unknown = null) {
    super(429, route, body);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
    this.message = `Discord ${route} rate limited for ${retryAfterMs} ms`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TOKEN_ROUTE = /^\/(webhooks|interactions)\/(\d+)\/([^/?]+)/;

/** Replaces the token in /webhooks/{id}/{token} and /interactions/{id}/{token}. */
export function redactPath(path: string): string {
  return path.replace(TOKEN_ROUTE, "/$1/$2/:token");
}

export function isTokenRoute(path: string): boolean {
  return TOKEN_ROUTE.test(path);
}

const MAJOR_PARAMETERS = new Set(["channels", "guilds", "webhooks"]);

/**
 * Stable key for a route: major parameters (channel, guild, webhook id) are
 * kept, other ids become ":id", tokens ":token", emoji ":emoji".
 */
export function routeKey(method: string, path: string): string {
  const segments = (path.split("?")[0] ?? "").split("/").filter(Boolean);
  const out = segments.map((segment, i) => {
    const prev = segments[i - 1];
    if (i === 2 && (segments[0] === "webhooks" || segments[0] === "interactions")) return ":token";
    if (prev === "reactions") return ":emoji";
    if (/^\d{15,25}$/.test(segment)) {
      return i === 1 && prev !== undefined && MAJOR_PARAMETERS.has(prev) ? segment : ":id";
    }
    return segment;
  });
  return `${method.toUpperCase()} /${out.join("/")}`;
}

function majorParameter(path: string): string {
  const segments = path.split("?")[0]?.split("/").filter(Boolean) ?? [];
  const first = segments[0];
  return first !== undefined && MAJOR_PARAMETERS.has(first) ? `${first}/${segments[1] ?? ""}` : "";
}

function withNoMentions<T extends Record<string, unknown>>(message: T): T {
  return message.allowed_mentions === undefined ? { ...message, allowed_mentions: noMentions() } : message;
}

const MESSAGE_TYPES = new Set([4, 7]);

/**
 * Adds allowed_mentions {parse: []} to every message-shaped body the bot
 * sends. Explicit allowed_mentions from the caller are kept.
 */
export function suppressMentions(method: string, path: string, body: unknown): unknown {
  if (!isRecord(body)) return body;
  const upper = method.toUpperCase();
  if (upper !== "POST" && upper !== "PATCH") return body;
  const clean = path.split("?")[0] ?? "";
  if (/^\/interactions\/\d+\/[^/]+\/callback$/.test(clean)) {
    if (MESSAGE_TYPES.has(Number(body.type)) && isRecord(body.data)) {
      return { ...body, data: withNoMentions(body.data) };
    }
    return body;
  }
  if (/^\/channels\/\d+\/threads$/.test(clean)) {
    return isRecord(body.message) ? { ...body, message: withNoMentions(body.message) } : body;
  }
  if (/\/messages(\/(?!bulk-delete$)[^/]+)?$/.test(clean) || /^\/webhooks\/\d+\/[^/]+$/.test(clean)) {
    return withNoMentions(body);
  }
  return body;
}

export interface DiscordClientOptions {
  /** Bot token. Optional when only token routes are used. */
  token?: string;
  fetch?: FetchLike;
  baseUrl?: string;
  /** Retries after a 429. Default 3. */
  maxRetries?: number;
  /** Longest wait the client accepts before throwing RateLimitError. Default 20 s. */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Clock in milliseconds. */
  now?: () => number;
}

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Audit log reason for mutating requests. Defaults to DEFAULT_AUDIT_REASON. */
  reason?: string;
  /** A user's OAuth access token, sent as Bearer instead of the bot token. */
  bearer?: string;
}

interface BucketState {
  remaining: number;
  resetAt: number;
}

export interface ForumPost {
  name: string;
  message: MessagePayload;
  applied_tags?: string[];
  auto_archive_duration?: number;
}

export class DiscordClient {
  readonly #token: string | undefined;
  readonly #fetch: FetchLike;
  readonly #baseUrl: string;
  readonly #maxRetries: number;
  readonly #maxWaitMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #routeBuckets = new Map<string, string>();
  readonly #buckets = new Map<string, BucketState>();
  #globalResetAt = 0;

  constructor(options: DiscordClientOptions = {}) {
    this.#token = options.token;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#baseUrl = options.baseUrl ?? API_BASE;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#maxWaitMs = options.maxWaitMs ?? 20_000;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? (() => Date.now());
  }

  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const upper = method.toUpperCase();
    const key = routeKey(upper, path);
    const route = `${upper} ${redactPath(path)}`;
    const url = this.#url(path, options.query);
    const body = options.body === undefined ? undefined : suppressMentions(upper, path, options.body);

    const headers: Record<string, string> = { "User-Agent": USER_AGENT };
    if (options.bearer !== undefined) {
      headers.Authorization = `Bearer ${options.bearer}`;
    } else if (!isTokenRoute(path)) {
      if (!this.#token) throw new Error(`Discord ${route} needs a bot token`);
      headers.Authorization = `Bot ${this.#token}`;
    }
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (upper !== "GET" && !isTokenRoute(path) && options.bearer === undefined) {
      headers["X-Audit-Log-Reason"] = encodeURIComponent(options.reason ?? DEFAULT_AUDIT_REASON);
    }
    const init: RequestInit = { method: upper, headers };
    if (body !== undefined) init.body = JSON.stringify(body);

    for (let attempt = 0; ; attempt++) {
      await this.#waitForBucket(key, path, route);
      const response = await this.#fetch(url, init);
      this.#updateBucket(key, path, response);

      if (response.status === 429) {
        const data = await readBody(response);
        const seconds =
          isRecord(data) && typeof data.retry_after === "number"
            ? data.retry_after
            : Number(response.headers.get("retry-after") ?? "1");
        const waitMs = Math.max(0, Math.ceil((Number.isFinite(seconds) ? seconds : 1) * 1000));
        const global = (isRecord(data) && data.global === true) || response.headers.get("x-ratelimit-global") === "true";
        if (global) this.#globalResetAt = this.#now() + waitMs;
        if (attempt >= this.#maxRetries || waitMs > this.#maxWaitMs) throw new RateLimitError(route, waitMs, data);
        await this.#sleep(waitMs);
        continue;
      }
      if (!response.ok) throw new DiscordError(response.status, route, await readBody(response));
      if (response.status === 204) return null as T;
      return (await readBody(response)) as T;
    }
  }

  #url(path: string, query: RequestOptions["query"]): string {
    const url = new URL(this.#baseUrl + path);
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    return url.toString();
  }

  #bucketKey(key: string, path: string): string {
    const hash = this.#routeBuckets.get(key);
    return hash ? `${hash}|${majorParameter(path)}` : key;
  }

  async #waitForBucket(key: string, path: string, route: string): Promise<void> {
    const now = this.#now();
    let waitMs = Math.max(0, this.#globalResetAt - now);
    const bucketKey = this.#bucketKey(key, path);
    const state = this.#buckets.get(bucketKey);
    if (state) {
      if (state.resetAt <= now) this.#buckets.delete(bucketKey);
      else if (state.remaining <= 0) waitMs = Math.max(waitMs, state.resetAt - now);
      else state.remaining -= 1;
    }
    if (waitMs <= 0) return;
    if (waitMs > this.#maxWaitMs) throw new RateLimitError(route, waitMs);
    await this.#sleep(waitMs);
    this.#buckets.delete(bucketKey);
  }

  #updateBucket(key: string, path: string, response: Response): void {
    const hash = response.headers.get("x-ratelimit-bucket");
    if (hash) this.#routeBuckets.set(key, hash);
    const remaining = response.headers.get("x-ratelimit-remaining");
    const resetAfter = response.headers.get("x-ratelimit-reset-after");
    if (remaining === null || resetAfter === null) return;
    const remainingNumber = Number(remaining);
    const resetAfterNumber = Number(resetAfter);
    if (!Number.isFinite(remainingNumber) || !Number.isFinite(resetAfterNumber)) return;
    this.#buckets.set(this.#bucketKey(key, path), {
      remaining: remainingNumber,
      resetAt: this.#now() + Math.ceil(resetAfterNumber * 1000),
    });
  }

  // --- reads -------------------------------------------------------------

  getChannel(channelId: string): Promise<Channel> {
    return this.request("GET", `/channels/${channelId}`);
  }

  getGuildChannels(guildId: string): Promise<Channel[]> {
    return this.request("GET", `/guilds/${guildId}/channels`);
  }

  getGuildRoles(guildId: string): Promise<Role[]> {
    return this.request("GET", `/guilds/${guildId}/roles`);
  }

  getActiveThreads(guildId: string): Promise<{ threads: Channel[] }> {
    return this.request("GET", `/guilds/${guildId}/threads/active`);
  }

  // --- messages and forum posts --------------------------------------------

  sendMessage(channelId: string, message: MessagePayload): Promise<{ id: string }> {
    return this.request("POST", `/channels/${channelId}/messages`, { body: message });
  }

  editMessage(channelId: string, messageId: string, message: MessagePayload): Promise<{ id: string }> {
    return this.request("PATCH", `/channels/${channelId}/messages/${messageId}`, { body: message });
  }

  /** Creates a post (thread plus starter message) in a forum or media channel. */
  createForumPost(forumId: string, post: ForumPost, reason?: string): Promise<Channel & { message?: { id: string } }> {
    const options: RequestOptions = { body: post };
    if (reason !== undefined) options.reason = reason;
    return this.request("POST", `/channels/${forumId}/threads`, options);
  }

  /** Channel or thread settings, e.g. {applied_tags} on a forum post. */
  editChannel(channelId: string, patch: Record<string, unknown>, reason?: string): Promise<Channel> {
    const options: RequestOptions = { body: patch };
    if (reason !== undefined) options.reason = reason;
    return this.request("PATCH", `/channels/${channelId}`, options);
  }

  executeWebhook(
    webhookId: string,
    webhookToken: string,
    message: MessagePayload & { thread_name?: string; applied_tags?: string[] },
    options: { threadId?: string; wait?: boolean } = {},
  ): Promise<{ id: string } | null> {
    return this.request("POST", `/webhooks/${webhookId}/${webhookToken}`, {
      body: message,
      query: { wait: options.wait ?? true, thread_id: options.threadId },
    });
  }

  // --- roles ---------------------------------------------------------------

  addMemberRole(guildId: string, userId: string, roleId: string, reason?: string): Promise<null> {
    const options: RequestOptions = {};
    if (reason !== undefined) options.reason = reason;
    return this.request("PUT", `/guilds/${guildId}/members/${userId}/roles/${roleId}`, options);
  }

  removeMemberRole(guildId: string, userId: string, roleId: string, reason?: string): Promise<null> {
    const options: RequestOptions = {};
    if (reason !== undefined) options.reason = reason;
    return this.request("DELETE", `/guilds/${guildId}/members/${userId}/roles/${roleId}`, options);
  }

  // --- interactions ----------------------------------------------------------

  /** Initial response sent out of band, instead of in the HTTP reply. */
  createInteractionResponse(interactionId: string, token: string, response: InteractionResponse): Promise<null> {
    return this.request("POST", `/interactions/${interactionId}/${token}/callback`, { body: response });
  }

  /** Follow-up message, valid for 15 minutes after the interaction. */
  followUp(applicationId: string, token: string, message: MessagePayload): Promise<{ id: string }> {
    return this.request("POST", `/webhooks/${applicationId}/${token}`, { body: message });
  }

  /** Replaces the deferred or initial response. */
  editOriginalResponse(applicationId: string, token: string, message: MessagePayload): Promise<{ id: string }> {
    return this.request("PATCH", `/webhooks/${applicationId}/${token}/messages/@original`, { body: message });
  }

  // --- application -------------------------------------------------------------

  bulkOverwriteGuildCommands(
    applicationId: string,
    guildId: string,
    commands: ApplicationCommandDefinition[],
  ): Promise<unknown[]> {
    return this.request("PUT", `/applications/${applicationId}/guilds/${guildId}/commands`, { body: commands });
  }

  putRoleConnectionMetadata(applicationId: string, records: RoleConnectionMetadata[]): Promise<unknown[]> {
    return this.request("PUT", `/applications/${applicationId}/role-connections/metadata`, { body: records });
  }
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 500);
  }
}
