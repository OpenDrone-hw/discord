/**
 * Shared helpers for the commands module: option access, role checks, forum
 * thread context, GitHub calls as the App installation, and text formatting.
 */
import { findRepo, type RepoMatch, type RoleKey } from "../config.ts";
import type { InteractionContext } from "../registry.ts";
import { ChannelType, type Channel, type Interaction } from "../types.ts";

/** Permission bit values used in command definitions and checks. */
export const Permission = {
  ADMINISTRATOR: 1n << 3n,
  SEND_MESSAGES: 1n << 11n,
} as const;

/** Guild-only command context (InteractionContextType.GUILD) for a guild-installed app. */
export function guildOnly(): { contexts: number[]; integration_types: number[] } {
  return { contexts: [0], integration_types: [0] };
}

/** Every member who can post may use the command; the handler checks roles. */
export const MEMBER_PERMISSIONS = Permission.SEND_MESSAGES.toString();
/** Only Administrators see the command until a role override is added in Server Settings, Integrations. */
export const ADMIN_PERMISSIONS = Permission.ADMINISTRATOR.toString();

export const MESSAGE_LIMIT = 2000;
const THREAD_TYPES = new Set<number>([ChannelType.PUBLIC_THREAD, 10, 12]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- options -------------------------------------------------------------------

type Option = { name: string; type: number; value?: unknown; focused?: boolean; options?: unknown[] };

function flatOptions(options: unknown[] | undefined): Option[] {
  const out: Option[] = [];
  for (const option of options ?? []) {
    if (!isRecord(option) || typeof option.name !== "string") continue;
    out.push(option as Option);
    if (Array.isArray(option.options)) out.push(...flatOptions(option.options));
  }
  return out;
}

export function stringOption(interaction: Interaction, name: string): string | undefined {
  const option = flatOptions(interaction.data?.options).find((o) => o.name === name);
  return typeof option?.value === "string" ? option.value.trim() : undefined;
}

/** The option being typed in an autocomplete interaction. */
export function focusedValue(interaction: Interaction): string {
  const option = flatOptions(interaction.data?.options).find((o) => o.focused);
  return typeof option?.value === "string" ? option.value : String(option?.value ?? "");
}

// --- people and roles ----------------------------------------------------------

export function invokerId(interaction: Interaction): string | undefined {
  return interaction.member?.user?.id ?? interaction.user?.id;
}

export function invokerName(interaction: Interaction): string {
  const user = interaction.member?.user ?? interaction.user;
  return user?.username ?? "unknown";
}

export function hasAdministrator(interaction: Interaction): boolean {
  const raw = interaction.member?.permissions;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return false;
  return (BigInt(raw) & Permission.ADMINISTRATOR) === Permission.ADMINISTRATOR;
}

/**
 * True when the invoking member holds one of the roles named by `keys`
 * (config/repos.json), or holds Administrator and `admin` is one of the keys.
 */
export async function hasRole(ctx: InteractionContext, keys: readonly RoleKey[]): Promise<boolean> {
  const member = ctx.interaction.member;
  if (!member) return false;
  if (keys.includes("admin") && hasAdministrator(ctx.interaction)) return true;
  const held = new Set(member.roles ?? []);
  const ids = await Promise.all(keys.map((key) => ctx.services.directory.roleId(key)));
  return ids.some((id) => id !== null && held.has(id));
}

/** Roles that count as a member for member-only commands. */
export const MEMBER_ROLES: readonly RoleKey[] = ["member", "admin", "developer", "reviewer", "betaTester"];
/** Roles that may see private-repository work in Discord. */
export const STAFF_ROLES: readonly RoleKey[] = ["admin", "developer"];

// --- forum threads -------------------------------------------------------------

export interface ThreadContext {
  thread: Channel;
  forum: Channel;
  /** Repositories whose development forum is this thread's forum, in repos.json order. */
  repos: RepoMatch[];
  /** Of those, the repositories whose product tag is applied to the thread. */
  tagged: RepoMatch[];
}

/**
 * The thread as the interaction describes it: a Channel when complete, null
 * when it is not a thread, undefined when the channel must be fetched.
 */
function threadFromInteraction(interaction: Interaction, channelId: string): Channel | null | undefined {
  const channel = interaction.channel;
  if (!isRecord(channel) || channel.id !== channelId || typeof channel.type !== "number") return undefined;
  if (!THREAD_TYPES.has(channel.type)) return null;
  if (typeof channel.parent_id !== "string" || !Array.isArray(channel.applied_tags)) return undefined;
  return channel as unknown as Channel;
}

/**
 * The development-forum thread `channelId` (default: where the interaction
 * happened) and the repositories mapped to its forum. Null when the channel
 * is not a thread in a forum listed in config/repos.json.
 */
export async function forumThread(ctx: InteractionContext, channelId?: string): Promise<ThreadContext | null> {
  const { interaction, services } = ctx;
  const id = channelId ?? interaction.channel_id;
  if (!id) return null;
  const known = threadFromInteraction(interaction, id);
  if (known === null) return null;
  const thread = known ?? (await services.discord.getChannel(id));
  if (!THREAD_TYPES.has(thread.type) || typeof thread.parent_id !== "string") return null;
  const forum = (await services.directory.channels()).find((c) => c.id === thread.parent_id);
  if (!forum || forum.type !== ChannelType.GUILD_FORUM || !forum.name) return null;
  const cfg = services.directory.config;
  if (!cfg.forums.includes(forum.name)) return null;
  const repos = Object.entries(cfg.repos)
    .filter(([, entry]) => entry.forum === forum.name)
    .map(([repo, entry]) => ({ repo, ...entry }));
  const applied = new Set(Array.isArray(thread.applied_tags) ? (thread.applied_tags as string[]) : []);
  const tagged = repos.filter((r) => {
    const tagId = services.directory.tagId(forum, r.tag);
    return tagId !== null && applied.has(tagId);
  });
  return { thread, forum, repos, tagged };
}

export function threadUrl(guildId: string, threadId: string): string {
  return `https://discord.com/channels/${guildId}/${threadId}`;
}

export function messageUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

// --- GitHub --------------------------------------------------------------------

/** One GitHub REST call as the App installation that covers `repo` in the configured organisation. */
export async function repoRequest<T>(
  ctx: InteractionContext,
  repo: string,
  method: string,
  path: string,
  options: { body?: unknown; query?: Record<string, string | number | boolean | undefined> } = {},
): Promise<T> {
  const { github, directory } = ctx.services;
  const installation = await github.installationForRepo(directory.config.org, repo);
  return github.request<T>(installation, method, path, options);
}

export function resolveRepoName(ctx: InteractionContext, name: string | undefined): RepoMatch | null {
  if (!name) return null;
  return findRepo(name, ctx.services.directory.config);
}

/** Autocomplete over config/repos.json: prefix matches first, then substring matches. */
export function repoChoices(ctx: InteractionContext, repos?: string[]): Array<{ name: string; value: string }> {
  const typed = focusedValue(ctx.interaction).trim().toLowerCase();
  const names = repos ?? Object.keys(ctx.services.directory.config.repos);
  const prefix = names.filter((n) => n.toLowerCase().startsWith(typed));
  const inner = names.filter((n) => !n.toLowerCase().startsWith(typed) && n.toLowerCase().includes(typed));
  return [...prefix, ...inner].slice(0, 25).map((n) => ({ name: n, value: n }));
}

// --- text ----------------------------------------------------------------------

/** Escapes Discord markdown so GitHub or user text renders literally. */
export function escapeMarkdown(text: string): string {
  return text.replace(/([\\*_~`|>#\[\]()<:-])/g, "\\$1").replace(/\r?\n/g, " ");
}

/** Text inside an inline code span; backticks are replaced because they cannot be escaped there. */
export function code(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

/** Joins lines; lines that do not fit in `max` characters are replaced by a count. */
export function fitLines(lines: string[], max = MESSAGE_LIMIT): string {
  const out: string[] = [];
  let length = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const rest = lines.length - i - 1;
    const reserve = rest > 0 ? `\n(${rest} more lines not shown)`.length : 0;
    if (length + line.length + reserve > max) {
      out.push(`(${lines.length - i} more lines not shown)`);
      return out.join("\n");
    }
    out.push(line);
    length += line.length + 1;
  }
  return out.join("\n");
}

/** Git branch name from a thread title: lowercase ASCII words joined by hyphens, at most 48 characters. */
export function branchSlug(title: string, fallback: string): string {
  const ascii = title.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  let slug = ascii.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug.length > 48) {
    const cut = slug.slice(0, 48);
    const dash = cut.lastIndexOf("-");
    slug = (dash >= 16 ? cut.slice(0, dash) : cut).replace(/-+$/, "");
  }
  return slug || fallback;
}

/** Resolves with `promise`, or with null once `ms` pass. The promise keeps running. */
export function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
