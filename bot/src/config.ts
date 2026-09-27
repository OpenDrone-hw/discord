/**
 * Bot configuration: bot/config/repos.json maps every OpenDrone-hw repository
 * to its development forum and product tag, and names the channels and roles
 * the bot uses. Everything is referenced by name; ids are resolved at runtime
 * through the Discord API (Directory) and cached per isolate, so the file
 * holds no channel, role or tag ids.
 */
import raw from "../config/repos.json" with { type: "json" };
import type { DiscordClient } from "./discord.ts";
import { ChannelType, type Channel, type Role } from "./types.ts";

export const MAX_FORUM_TAGS = 20;
export const MAX_TAG_NAME = 20;
const CHANNEL_NAME = /^[a-z0-9_-]{1,100}$/;

export const CHANNEL_KEYS = ["gitFeed", "announcements", "modLog"] as const;
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
  /** Development forum channel name. */
  forum: string;
  /** Product tag name in that forum. */
  tag: string;
}

export interface BotConfig {
  org: string;
  channels: Record<ChannelKey, string>;
  roles: Record<RoleKey, string>;
  /** Repository topic -> lifecycle tag name, present in every development forum. */
  lifecycleTags: Record<LifecycleTopic, string>;
  forums: string[];
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

/** Validates repos.json. Throws ConfigError naming the first problem. */
export function parseConfig(value: unknown): BotConfig {
  if (!isRecord(value)) throw new ConfigError("repos.json: expected an object");
  const org = nonEmpty(value.org, "org");

  const channelsIn = isRecord(value.channels) ? value.channels : {};
  const channels = {} as Record<ChannelKey, string>;
  for (const key of CHANNEL_KEYS) channels[key] = channelName(channelsIn[key], `channels.${key}`);

  const rolesIn = isRecord(value.roles) ? value.roles : {};
  const roles = {} as Record<RoleKey, string>;
  for (const key of ROLE_KEYS) roles[key] = nonEmpty(rolesIn[key], `roles.${key}`);

  const lifecycleIn = isRecord(value.lifecycleTags) ? value.lifecycleTags : {};
  const lifecycleTags = {} as Record<LifecycleTopic, string>;
  for (const topic of LIFECYCLE_TOPICS) {
    lifecycleTags[topic] = nonEmpty(lifecycleIn[topic], `lifecycleTags.${topic}`, MAX_TAG_NAME);
  }
  for (const key of Object.keys(lifecycleIn)) {
    if (!(LIFECYCLE_TOPICS as readonly string[]).includes(key)) throw new ConfigError(`lifecycleTags: unknown topic ${key}`);
  }

  if (!Array.isArray(value.forums) || value.forums.length === 0) throw new ConfigError("forums: expected a list");
  const forums = value.forums.map((f, i) => channelName(f, `forums[${i}]`));
  if (new Set(forums).size !== forums.length) throw new ConfigError("forums: duplicate name");

  if (!isRecord(value.repos)) throw new ConfigError("repos: expected an object");
  const repos: Record<string, RepoEntry> = {};
  const seenRepos = new Set<string>();
  const tagsByForum = new Map<string, Set<string>>(forums.map((f) => [f, new Set<string>()]));
  for (const [repo, entry] of Object.entries(value.repos)) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo)) throw new ConfigError(`repos: ${JSON.stringify(repo)} is not a repository name`);
    if (seenRepos.has(repo.toLowerCase())) throw new ConfigError(`repos: ${repo} is listed twice`);
    seenRepos.add(repo.toLowerCase());
    if (!isRecord(entry)) throw new ConfigError(`repos.${repo}: expected an object`);
    const forum = channelName(entry.forum, `repos.${repo}.forum`);
    const tag = nonEmpty(entry.tag, `repos.${repo}.tag`, MAX_TAG_NAME);
    const tags = tagsByForum.get(forum);
    if (!tags) throw new ConfigError(`repos.${repo}.forum: ${forum} is not in forums`);
    if (tags.has(tag.toLowerCase())) throw new ConfigError(`repos.${repo}.tag: ${tag} is already used in ${forum}`);
    tags.add(tag.toLowerCase());
    repos[repo] = { forum, tag };
  }
  for (const [forum, tags] of tagsByForum) {
    const total = tags.size + LIFECYCLE_TOPICS.length;
    if (total > MAX_FORUM_TAGS) {
      throw new ConfigError(`${forum}: ${total} product and lifecycle tags exceed Discord's ${MAX_FORUM_TAGS}`);
    }
  }
  return { org, channels, roles, lifecycleTags, forums, repos };
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
  forumId: string;
  /** null when the forum has no tag with the configured name. */
  tagId: string | null;
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

  async forum(name: string): Promise<Channel | null> {
    return this.channelByName(name, [ChannelType.GUILD_FORUM, ChannelType.GUILD_MEDIA]);
  }

  /** Tag id by name, case-insensitive. */
  tagId(forum: Channel, tagName: string): string | null {
    const lower = tagName.toLowerCase();
    return forum.available_tags?.find((t) => t.name.toLowerCase() === lower)?.id ?? null;
  }

  /**
   * Forum and product tag for a repository. Returns null for a repository not
   * in repos.json; throws ConfigError when its forum is missing on the server.
   */
  async resolveRepo(fullName: string): Promise<ResolvedRepo | null> {
    const match = findRepo(fullName, this.config);
    if (!match) return null;
    const forum = await this.forum(match.forum);
    if (!forum) throw new ConfigError(`forum ${match.forum} for ${match.repo} does not exist on the server`);
    return { ...match, forumId: forum.id, tagId: this.tagId(forum, match.tag) };
  }

  /** Lifecycle tag id in a forum for a status-* repository topic. */
  lifecycleTagId(forum: Channel, topic: LifecycleTopic): string | null {
    return this.tagId(forum, this.config.lifecycleTags[topic]);
  }
}
