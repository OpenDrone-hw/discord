/**
 * Bot configuration: bot/config/repos.json maps every OpenDrone-hw repository
 * to its product text channel, and names the channels and roles the bot uses.
 * Everything is referenced by name; ids are resolved at runtime through the
 * Discord API (Directory) and cached per isolate, so the file holds no
 * channel or role ids.
 */
import raw from "../config/repos.json" with { type: "json" };
import type { DiscordClient } from "./discord.ts";
import { ChannelType, type Channel, type Role } from "./types.ts";

const CHANNEL_NAME = /^[a-z0-9_-]{1,100}$/;

export const CHANNEL_KEYS = ["gitFeed", "modLog"] as const;
export const ROLE_KEYS = [
  "admin",
  "developer",
  "betaTester",
  "reviewer",
  "member",
  "verifiedOwner",
  "verifiedBuilder",
  "contributor",
  "maintainer",
] as const;
export const LIFECYCLE_TOPICS = [
  "status-planned",
  "status-in-progress",
  "status-alpha",
  "status-beta",
  "status-launched",
] as const;

export type ChannelKey = (typeof CHANNEL_KEYS)[number];
export type RoleKey = (typeof ROLE_KEYS)[number];
export type LifecycleTopic = (typeof LIFECYCLE_TOPICS)[number];

export interface RepoEntry {
  /** Product text channel name: pull request threads start there. */
  channel: string;
}

export interface BotConfig {
  org: string;
  channels: Record<ChannelKey, string>;
  roles: Record<RoleKey, string>;
  /** Repository topic -> lifecycle name shown in the product channel and #git-feed. */
  lifecycle: Record<LifecycleTopic, string>;
  repos: Record<string, RepoEntry>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown, where: string, max = 100): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new ConfigError(`${where}: expected a non-empty string of at most ${max} characters`);
  }
  return value;
}

function channelName(value: unknown, where: string): string {
  const name = nonEmpty(value, where);
  if (!CHANNEL_NAME.test(name)) throw new ConfigError(`${where}: ${JSON.stringify(name)} is not a Discord channel name`);
  return name;
}

const TOP_KEYS = new Set(["org", "channels", "roles", "lifecycle", "repos"]);

/** Validates repos.json. Throws ConfigError naming the first problem. */
export function parseConfig(value: unknown): BotConfig {
  if (!isRecord(value)) throw new ConfigError("repos.json: expected an object");
  for (const key of Object.keys(value)) {
    if (!TOP_KEYS.has(key)) throw new ConfigError(`repos.json: unknown key ${key}`);
  }
  const org = nonEmpty(value.org, "org");

  const channelsIn = isRecord(value.channels) ? value.channels : {};
  const channels = {} as Record<ChannelKey, string>;
  for (const key of CHANNEL_KEYS) channels[key] = channelName(channelsIn[key], `channels.${key}`);

  const rolesIn = isRecord(value.roles) ? value.roles : {};
  const roles = {} as Record<RoleKey, string>;
  for (const key of ROLE_KEYS) roles[key] = nonEmpty(rolesIn[key], `roles.${key}`);

  const lifecycleIn = isRecord(value.lifecycle) ? value.lifecycle : {};
  const lifecycle = {} as Record<LifecycleTopic, string>;
  for (const topic of LIFECYCLE_TOPICS) lifecycle[topic] = nonEmpty(lifecycleIn[topic], `lifecycle.${topic}`);
  for (const key of Object.keys(lifecycleIn)) {
    if (!(LIFECYCLE_TOPICS as readonly string[]).includes(key)) throw new ConfigError(`lifecycle: unknown topic ${key}`);
  }

  if (!isRecord(value.repos)) throw new ConfigError("repos: expected an object");
  const repos: Record<string, RepoEntry> = {};
  const seenRepos = new Set<string>();
  const shared = new Set<string>(Object.values(channels));
  for (const [repo, entry] of Object.entries(value.repos)) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo)) throw new ConfigError(`repos: ${JSON.stringify(repo)} is not a repository name`);
    if (seenRepos.has(repo.toLowerCase())) throw new ConfigError(`repos: ${repo} is listed twice`);
    seenRepos.add(repo.toLowerCase());
    if (!isRecord(entry)) throw new ConfigError(`repos.${repo}: expected an object`);
    for (const key of Object.keys(entry)) {
      if (key !== "channel") throw new ConfigError(`repos.${repo}: unknown key ${key}`);
    }
    const channel = channelName(entry.channel, `repos.${repo}.channel`);
    if (shared.has(channel)) throw new ConfigError(`repos.${repo}.channel: ${channel} is a bot channel, not a product channel`);
    repos[repo] = { channel };
  }
  if (Object.keys(repos).length === 0) throw new ConfigError("repos: expected at least one repository");
  return { org, channels, roles, lifecycle, repos };
}

export const config: BotConfig = parseConfig(raw);

export interface RepoMatch extends RepoEntry {
  /** Repository name as written in repos.json. */
  repo: string;
}

/**
 * Looks up "owner/name" or "name". GitHub names are case-insensitive; a
 * repository outside the configured organisation returns null.
 */
export function findRepo(fullName: string, cfg: BotConfig = config): RepoMatch | null {
  const parts = fullName.split("/");
  if (parts.length > 2) return null;
  const [owner, name] = parts.length === 2 ? parts : [cfg.org, parts[0]];
  if (!owner || !name || owner.toLowerCase() !== cfg.org.toLowerCase()) return null;
  const lower = name.toLowerCase();
  for (const [repo, entry] of Object.entries(cfg.repos)) {
    if (repo.toLowerCase() === lower) return { repo, ...entry };
  }
  return null;
}

/** Product channel names in repos.json order, each once. */
export function productChannels(cfg: BotConfig = config): string[] {
  return [...new Set(Object.values(cfg.repos).map((entry) => entry.channel))];
}

/** Repositories mapped to one product channel, in repos.json order. */
export function reposInChannel(channel: string, cfg: BotConfig = config): RepoMatch[] {
  return Object.entries(cfg.repos)
    .filter(([, entry]) => entry.channel === channel)
    .map(([repo, entry]) => ({ repo, ...entry }));
}

// --- runtime name -> id resolution -------------------------------------------

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

/** Per-guild cache of channel and role lists, shared by every request in an isolate. */
export class DirectoryCache {
  readonly channels = new Map<string, Cached<Channel[]>>();
  readonly roles = new Map<string, Cached<Role[]>>();

  clear(): void {
    this.channels.clear();
    this.roles.clear();
  }
}

export const sharedDirectoryCache = new DirectoryCache();

export interface ResolvedRepo extends RepoMatch {
  channelId: string;
}

export interface DirectoryOptions {
  config?: BotConfig;
  cache?: DirectoryCache;
  /** Cache lifetime. Default five minutes. */
  ttlMs?: number;
  now?: () => number;
}

const THREAD_TYPES = new Set<number>([10, 11, 12]);

export class Directory {
  readonly config: BotConfig;
  readonly #discord: DiscordClient;
  readonly #guildId: string;
  readonly #cache: DirectoryCache;
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(discord: DiscordClient, guildId: string, options: DirectoryOptions = {}) {
    this.#discord = discord;
    this.#guildId = guildId;
    this.config = options.config ?? config;
    this.#cache = options.cache ?? sharedDirectoryCache;
    this.#ttlMs = options.ttlMs ?? 300_000;
    this.#now = options.now ?? (() => Date.now());
  }

  #cached<T>(map: Map<string, Cached<T>>, load: () => Promise<T>): Promise<T> {
    const hit = map.get(this.#guildId);
    if (hit && this.#now() - hit.at < this.#ttlMs) return hit.value;
    const value = load();
    map.set(this.#guildId, { at: this.#now(), value });
    value.catch(() => {
      if (map.get(this.#guildId)?.value === value) map.delete(this.#guildId);
    });
    return value;
  }

  /** Drops cached lists, e.g. after the bot created a channel or role. */
  invalidate(): void {
    this.#cache.channels.delete(this.#guildId);
    this.#cache.roles.delete(this.#guildId);
  }

  channels(): Promise<Channel[]> {
    return this.#cached(this.#cache.channels, () => this.#discord.getGuildChannels(this.#guildId));
  }

  roles(): Promise<Role[]> {
    return this.#cached(this.#cache.roles, () => this.#discord.getGuildRoles(this.#guildId));
  }

  /** Channel by exact name, optionally restricted to channel types. Throws when ambiguous. */
  async channelByName(name: string, types?: number[]): Promise<Channel | null> {
    const matches = (await this.channels()).filter(
      (c) => c.name === name && !THREAD_TYPES.has(c.type) && (!types || types.includes(c.type)),
    );
    if (matches.length > 1) throw new ConfigError(`channel name ${name} is ambiguous (${matches.length} channels)`);
    return matches[0] ?? null;
  }

  async channelId(key: ChannelKey): Promise<string | null> {
    return (await this.channelByName(this.config.channels[key]))?.id ?? null;
  }

  /** Role by exact name. Throws when two roles share the name. */
  async roleByName(name: string): Promise<Role | null> {
    const matches = (await this.roles()).filter((r) => r.name === name);
    if (matches.length > 1) throw new ConfigError(`role name ${name} is ambiguous (${matches.length} roles)`);
    return matches[0] ?? null;
  }

  async roleId(key: RoleKey): Promise<string | null> {
    return (await this.roleByName(this.config.roles[key]))?.id ?? null;
  }

  /** A product text channel by name. */
  async productChannel(name: string): Promise<Channel | null> {
    return this.channelByName(name, [ChannelType.GUILD_TEXT]);
  }

  /**
   * Product channel of a repository. Returns null for a repository not in
   * repos.json; throws ConfigError when its channel is missing on the server.
   */
  async resolveRepo(fullName: string): Promise<ResolvedRepo | null> {
    const match = findRepo(fullName, this.config);
    if (!match) return null;
    const channel = await this.productChannel(match.channel);
    if (!channel) throw new ConfigError(`text channel ${match.channel} for ${match.repo} does not exist on the server`);
    return { ...match, channelId: channel.id };
  }
}
