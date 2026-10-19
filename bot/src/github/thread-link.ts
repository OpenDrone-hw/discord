/**
 * Links between pull requests and Discord threads in product channels.
 *
 * The link lives in the PR body as one line:
 *
 *   Discussion: https://discord.com/channels/<guild>/<thread>
 *
 * It is the only record of the link: nothing is stored in D1. The bot does
 * not start PR threads or post into them; the /link and /branch commands use
 * discussionUrl() and withDiscussionLine() to write the line.
 *
 * Issue threads (issues.ts) share the thread name length, auto-archive time
 * and the "already started" error code.
 */
import { oneLine, truncate } from "./format.ts";
import type { PullRequest } from "./payload.ts";

const DISCUSSION_LINE =
  /^[ \t]*Discussion:[ \t]*<?https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(\d{17,20})\/(\d{17,20})(?:\/\d{17,20})?\/?>?[ \t]*$/gim;

export const MAX_THREAD_NAME = 100;
/** A week: the longest auto-archive time Discord offers. */
export const AUTO_ARCHIVE_MINUTES = 10080;
/** Discord error code: a thread was already started from this message. */
export const THREAD_ALREADY_CREATED = 160004;

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

/**
 * "<repo> #<number>: <title>", cut to Discord's 100 characters. The command
 * module reads the repository back from this prefix (src/commands/util.ts
 * parsePullThreadName), so keep the two in step.
 */
export function threadName(repo: string, pull: Pick<PullRequest, "number" | "title">): string {
  return truncate(`${repo} #${pull.number}: ${oneLine(pull.title)}`, MAX_THREAD_NAME);
}
