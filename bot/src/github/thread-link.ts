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
 */
import type { MessagePayload } from "../types.ts";
import { currentStatus, type Scope } from "./context.ts";
import { oneLine, truncate } from "./format.ts";
import type { PullRequest } from "./payload.ts";

const DISCUSSION_LINE =
  /^[ \t]*Discussion:[ \t]*<?https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(\d{17,20})\/(\d{17,20})(?:\/\d{17,20})?\/?>?[ \t]*$/gim;

export const MAX_THREAD_NAME = 100;
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
 * The PR's thread. The payload body is checked first; when it has no line
 * the PR is read again from GitHub, because a redelivered payload carries the
 * body from before the bot added the line.
 */
export async function findOrCreateThread(scope: Scope, pull: PullRequest, options: ThreadOptions): Promise<ThreadRef | null> {
  const fromPayload = parseDiscussion(pull.body, scope.guildId);
  if (fromPayload) return { threadId: fromPayload, created: false };

  const fresh = (await scope.api.pull(pull.number)) ?? pull;
  const fromApi = parseDiscussion(fresh.body, scope.guildId);
  if (fromApi) return { threadId: fromApi, created: false };
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
