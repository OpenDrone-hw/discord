/**
 * Links between pull requests and Discord threads in product channels.
 *
 * The link lives in the PR body as one line:
 *
 *   Discussion: https://discord.com/channels/<guild>/<thread>
 *
 * It is the only record of the link: nothing is stored in D1. For a PR
 * without the line the bot posts a short starter message in its repository's
 * product text channel (config/repos.json), starts a public thread from it
 * and then appends the line to the PR body. Other writers (the /link command)
 * use discussionUrl() and withDiscussionLine() to write the same format.
 *
 * The PR body is written by the PR author, forks included, so a parsed id is
 * trusted only after linkedThread() has read the channel from Discord and
 * found a thread (type 11 or 12) whose parent is this repository's product
 * channel. Any other target (a channel itself, #announcements, a support forum
 * post, a thread in another product channel) is logged and the PR is treated
 * as having no usable link: nothing is posted for it and no second thread is
 * created.
 */
import { DiscordError, type DiscordClient } from "../discord.ts";
import type { MessagePayload } from "../types.ts";
import type { Scope } from "./context.ts";
import { oneLine, truncate } from "./format.ts";
import type { PullRequest } from "./payload.ts";

const DISCUSSION_LINE =
  /^[ \t]*Discussion:[ \t]*<?https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(\d{17,20})\/(\d{17,20})(?:\/\d{17,20})?\/?>?[ \t]*$/gim;

export const MAX_THREAD_NAME = 100;
const PUBLIC_THREAD = 11;
const PRIVATE_THREAD = 12;
/** A week: the longest auto-archive time Discord offers. */
export const AUTO_ARCHIVE_MINUTES = 10080;
/** Discord error code: a thread was already started from this message. */
const THREAD_ALREADY_CREATED = 160004;

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
 * Parent channel id of a thread, or null when the id is not a thread or does
 * not exist. A thread never moves to another channel, so the answer is cached
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
 * for a thread in the product channel config/repos.json assigns to this
 * repository.
 */
export async function linkState(scope: Scope, body: string | null | undefined): Promise<LinkState> {
  const channelId = parseDiscussion(body, scope.guildId);
  if (!channelId) return { kind: "none" };
  const resolved = await scope.services.directory.resolveRepo(scope.repo.fullName);
  const parent = resolved ? await threadParent(scope.services.discord, channelId) : null;
  if (resolved && parent === resolved.channelId) return { kind: "linked", threadId: channelId };
  console.warn(
    `${scope.repo.fullName}: Discussion line points at ${channelId}, which is not a thread in ` +
      `${resolved ? `#${resolved.channel}` : "a configured product channel"}; ignored`,
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

export function threadName(pull: Pick<PullRequest, "number" | "title">): string {
  return truncate(`PR #${pull.number}: ${oneLine(pull.title)}`, MAX_THREAD_NAME);
}

export interface ThreadRef {
  threadId: string;
  /** True when this delivery created the thread. */
  created: boolean;
}

export interface ThreadOptions {
  /** Start a thread when the PR has no link. */
  create: boolean;
  /** Short starter message posted in the product channel, built from the current PR. */
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
  // A rejected line stays in the body; starting a thread would repeat on every event.
  if (fromApi.kind === "rejected") return null;
  if (!options.create || fresh.state !== "open") return null;

  const { directory, discord } = scope.services;
  const resolved = await directory.resolveRepo(scope.repo.fullName);
  if (!resolved) return null;

  const reason = `GitHub ${scope.repo.fullName}#${fresh.number}`;
  const starterId = await scope.once("starter", async () => {
    const message = await discord.sendMessage(resolved.channelId, options.starter(fresh));
    return message.id;
  });
  if (!starterId) return null;
  const threadId = await scope.once("thread", async () => {
    try {
      const thread = await discord.startThread(
        resolved.channelId,
        starterId,
        { name: threadName(fresh), auto_archive_duration: AUTO_ARCHIVE_MINUTES },
        reason,
      );
      return thread.id;
    } catch (error) {
      // A retried step after the thread was started: the thread id is the message id.
      if (error instanceof DiscordError && error.code === THREAD_ALREADY_CREATED) return starterId;
      throw error;
    }
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
