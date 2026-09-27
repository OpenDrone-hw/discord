/**
 * Links between pull requests and Discord forum threads.
 *
 * The link lives in the PR body as one line:
 *
 *   Discussion: https://discord.com/channels/<guild>/<thread>
 *
 * It is the only record of the link: nothing is stored in D1. A PR without
 * the line gets a new post in its repository's forum (config/repos.json),
 * tagged with the product tag and the repository's current lifecycle tag,
 * and the bot then appends the line to the PR body. Other writers (the /link
 * command) use discussionUrl() and withDiscussionLine() to write the same
 * format.
 *
 * The PR body is written by the PR author, forks included, so a parsed id is
 * trusted only after linkedThread() has read the channel from Discord and
 * found a thread (type 11 or 12) whose parent is this repository's forum.
 * Any other target (a text channel, #announcements, a support forum post, a
 * thread in another forum) is logged and the PR is treated as having no
 * usable link: nothing is posted for it and no second post is created.
 */
import { DiscordError, type DiscordClient } from "../discord.ts";
import type { MessagePayload } from "../types.ts";
import { currentStatus, type Scope } from "./context.ts";
import { oneLine, truncate } from "./format.ts";
import type { PullRequest } from "./payload.ts";

const DISCUSSION_LINE =
  /^[ \t]*Discussion:[ \t]*<?https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(\d{17,20})\/(\d{17,20})(?:\/\d{17,20})?\/?>?[ \t]*$/gim;

export const MAX_THREAD_NAME = 100;
const PUBLIC_THREAD = 11;
const PRIVATE_THREAD = 12;
export const MAX_APPLIED_TAGS = 5;

export function discussionUrl(guildId: string, threadId: string): string {
  return `https://discord.com/channels/${guildId}/${threadId}`;
}

/** Thread id from the first "Discussion:" line that points into `guildId`, else null. */
export function parseDiscussion(body: string | null | undefined, guildId: string): string | null {
  if (!body) return null;
  for (const match of body.matchAll(DISCUSSION_LINE)) {
    if (match[1] === guildId && match[2]) return match[2];
  }
  return null;
}

/**
 * Parent forum id of a thread, or null when the id is not a thread or does
 * not exist. A thread never moves to another forum, so the answer is cached
 * for the life of the isolate.
 */
const threadParents = new Map<string, string | null>();
const MAX_CACHED_PARENTS = 2000;

export function clearThreadParentCache(): void {
  threadParents.clear();
}

async function threadParent(discord: DiscordClient, channelId: string): Promise<string | null> {
  if (threadParents.has(channelId)) return threadParents.get(channelId) ?? null;
  let parent: string | null = null;
  try {
    const channel = await discord.getChannel(channelId);
    if (channel.type === PUBLIC_THREAD || channel.type === PRIVATE_THREAD) parent = channel.parent_id ?? null;
  } catch (error) {
    if (!(error instanceof DiscordError && (error.status === 404 || error.status === 403))) throw error;
  }
  if (threadParents.size >= MAX_CACHED_PARENTS) threadParents.clear();
  threadParents.set(channelId, parent);
  return parent;
}

/** Outcome of reading the "Discussion:" line of a PR body. */
export type LinkState = { kind: "none" } | { kind: "linked"; threadId: string } | { kind: "rejected"; channelId: string };

/**
 * The PR body's "Discussion:" line, checked against Discord: "linked" only
 * for a thread in the forum config/repos.json assigns to this repository.
 */
export async function linkState(scope: Scope, body: string | null | undefined): Promise<LinkState> {
  const channelId = parseDiscussion(body, scope.guildId);
  if (!channelId) return { kind: "none" };
  const resolved = await scope.services.directory.resolveRepo(scope.repo.fullName);
  const parent = resolved ? await threadParent(scope.services.discord, channelId) : null;
  if (resolved && parent === resolved.forumId) return { kind: "linked", threadId: channelId };
  console.warn(
    `${scope.repo.fullName}: Discussion line points at ${channelId}, which is not a thread in ` +
      `${resolved ? `#${resolved.forum}` : "a configured forum"}; ignored`,
  );
  return { kind: "rejected", channelId };
}

/** The verified thread id of a PR body, else null. */
export async function linkedThread(scope: Scope, body: string | null | undefined): Promise<string | null> {
  const state = await linkState(scope, body);
  return state.kind === "linked" ? state.threadId : null;
}

/** The PR body with a "Discussion:" line appended after a blank line. */
export function withDiscussionLine(body: string | null | undefined, url: string): string {
  const current = (body ?? "").replace(/\s+$/, "");
  return current ? `${current}\n\nDiscussion: ${url}` : `Discussion: ${url}`;
}

export function threadName(repoName: string, pull: Pick<PullRequest, "number" | "title">): string {
  return truncate(`${repoName} #${pull.number}: ${oneLine(pull.title)}`, MAX_THREAD_NAME);
}

export interface ThreadRef {
  threadId: string;
  /** True when this delivery created the thread; its starter message already shows the PR. */
  created: boolean;
}

export interface ThreadOptions {
  /** Create a forum post when the PR has no link. */
  create: boolean;
  /** Starter message for a new post, built from the current PR. */
  starter: (pull: PullRequest) => MessagePayload;
}

/**
 * The PR's verified thread. The payload body is checked first; when it has no line
 * the PR is read again from GitHub, because a redelivered payload carries the
 * body from before the bot added the line.
 */
export async function findOrCreateThread(scope: Scope, pull: PullRequest, options: ThreadOptions): Promise<ThreadRef | null> {
  const fromPayload = await linkState(scope, pull.body);
  if (fromPayload.kind === "linked") return { threadId: fromPayload.threadId, created: false };
  if (fromPayload.kind === "rejected") return null;

  const fresh = (await scope.api.pull(pull.number)) ?? pull;
  const fromApi = await linkState(scope, fresh.body);
  if (fromApi.kind === "linked") return { threadId: fromApi.threadId, created: false };
  // A rejected line stays in the body; creating a post would repeat on every event.
  if (fromApi.kind === "rejected") return null;
  if (!options.create || fresh.state !== "open") return null;

  const { directory, discord } = scope.services;
  const resolved = await directory.resolveRepo(scope.repo.fullName);
  if (!resolved) return null;

  const threadId = await scope.once("thread", async () => {
    const tags: string[] = [];
    if (resolved.tagId) tags.push(resolved.tagId);
    else console.warn(`forum ${resolved.forum} has no tag ${resolved.tag}`);
    const status = currentStatus(scope.repo.topics);
    const forum = status ? await directory.forum(resolved.forum) : null;
    const lifecycle = forum && status ? directory.lifecycleTagId(forum, status) : null;
    if (lifecycle) tags.push(lifecycle);
    const post = await discord.createForumPost(
      resolved.forumId,
      {
        name: threadName(scope.repo.name, fresh),
        message: options.starter(fresh),
        applied_tags: tags.slice(0, MAX_APPLIED_TAGS),
      },
      `GitHub ${scope.repo.fullName}#${fresh.number}`,
    );
    return post.id;
  });
  if (!threadId) return null;

  await scope.once("link", async () => {
    // Read again right before writing so an edit made meanwhile is kept.
    const latest = (await scope.api.pull(pull.number)) ?? fresh;
    if (parseDiscussion(latest.body, scope.guildId)) return;
    await scope.api.setPullBody(pull.number, withDiscussionLine(latest.body, discussionUrl(scope.guildId, threadId)));
  });
  return { threadId, created: true };
}
