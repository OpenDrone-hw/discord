/**
 * Pull request, review and check suite events: cards in the PR's forum
 * thread, compact lines in #git-feed.
 *
 * | Event.action                   | Thread                          | #git-feed        |
 * |--------------------------------|---------------------------------|------------------|
 * | pull_request.opened            | created if missing, PR card     | yes              |
 * | pull_request.reopened          | created if missing, card        | yes              |
 * | pull_request.ready_for_review  | created if missing, card        | yes              |
 * | pull_request.synchronize       | created if missing, push line   | no               |
 * | pull_request.closed            | card if linked (merged/closed)  | yes              |
 * | pull_request_review.submitted  | created if missing, review card | approve/changes  |
 * | check_suite.completed          | card if linked, PR head only    | default-branch   |
 * |                                |                                 | failures only    |
 *
 * Private repositories post nothing to Discord.
 */
import type { GitHubEventContext } from "../registry.ts";
import type { MessagePayload } from "../types.ts";
import { checkCollisions } from "./collisions.ts";
import { makeScope, postToChannel, postToThread, runAll, type Scope } from "./context.ts";
import {
  Colors,
  card,
  code,
  escapeMarkdown,
  feedLine,
  link,
  plainExcerpt,
  shortSha,
} from "./format.ts";
import { readCheckSuite, readPull, readReview, str, type PullRequest, type Review } from "./payload.ts";
import { findOrCreateThread, linkedThread } from "./thread-link.ts";

export const PULL_ACTIONS = ["opened", "reopened", "ready_for_review", "synchronize", "closed"];
const OPENING = new Set(["opened", "reopened", "ready_for_review"]);
const COLLISION_ACTIONS = new Set(["opened", "reopened", "ready_for_review", "synchronize"]);
export const REPORTED_CONCLUSIONS: Record<string, { text: string; color: number }> = {
  success: { text: "passed", color: Colors.success },
  failure: { text: "failed", color: Colors.failure },
  timed_out: { text: "timed out", color: Colors.failure },
  action_required: { text: "need action", color: Colors.warning },
  startup_failure: { text: "failed to start", color: Colors.failure },
};
const DISCUSSION_TEXT = /^[ \t]*Discussion:.*$/gim;

function heading(scope: Scope, pull: PullRequest): string {
  return `### ${link(`${scope.repo.name} #${pull.number}: ${pull.title}`, pull.htmlUrl)}`;
}

function stats(pull: PullRequest): string {
  if (pull.changedFiles === undefined) return "";
  const lines = pull.additions !== undefined && pull.deletions !== undefined ? `, +${pull.additions} -${pull.deletions}` : "";
  return `-# ${pull.changedFiles} ${pull.changedFiles === 1 ? "file" : "files"} changed${lines}`;
}

function description(pull: PullRequest, max: number): string {
  return plainExcerpt(pull.body.replace(DISCUSSION_TEXT, ""), max);
}

interface PullEvent {
  actor: string;
  text: string;
  color: number;
  feed: string | null;
}

export function describePullEvent(action: string, pull: PullRequest, sender: string, after: string): PullEvent | null {
  switch (action) {
    case "opened":
      return pull.draft
        ? { actor: pull.author, text: "opened a draft pull request", color: Colors.draft, feed: "opened a draft" }
        : { actor: pull.author, text: "opened this pull request", color: Colors.open, feed: "opened" };
    case "reopened":
      return { actor: sender, text: "reopened this pull request", color: Colors.open, feed: "reopened" };
    case "ready_for_review":
      return { actor: sender, text: "marked this pull request ready for review", color: Colors.open, feed: "marked ready for review" };
    case "synchronize":
      return {
        actor: sender,
        text: `pushed ${code(shortSha(after || pull.headSha))} to ${code(pull.headRef)}`,
        color: Colors.neutral,
        feed: null,
      };
    case "closed":
      return pull.merged
        ? {
            actor: pull.mergedBy ?? sender,
            text: `merged this pull request into ${code(pull.baseRef)}`,
            color: Colors.merged,
            feed: "merged",
          }
        : { actor: sender, text: "closed this pull request without merging", color: Colors.closed, feed: "closed" };
    default:
      return null;
  }
}

/** Starter message of a new forum post: the PR as it is now. */
export function pullStarter(scope: Scope, pull: PullRequest): MessagePayload {
  return card({
    color: pull.draft ? Colors.draft : Colors.open,
    blocks: [
      heading(scope, pull),
      `**${escapeMarkdown(pull.author)}** ${pull.draft ? "opened a draft pull request" : "opened this pull request"}: ${code(pull.headRef)} into ${code(pull.baseRef)}`,
      description(pull, 800),
      stats(pull),
    ],
    button: { label: "Open on GitHub", url: pull.htmlUrl },
  });
}

function eventCard(scope: Scope, pull: PullRequest, event: PullEvent, withDetails: boolean): MessagePayload {
  return card({
    color: event.color,
    blocks: [
      heading(scope, pull),
      `**${escapeMarkdown(event.actor)}** ${event.text}`,
      withDetails ? description(pull, 500) : "",
      withDetails ? stats(pull) : "",
    ],
    button: { label: "Open on GitHub", url: pull.htmlUrl },
  });
}

function feedText(scope: Scope, pull: PullRequest, verb: string, actor: string): string {
  return `**${escapeMarkdown(scope.repo.name)}** #${pull.number} ${verb} by ${escapeMarkdown(actor)}: ${link(pull.title, pull.htmlUrl)}`;
}

export async function handlePullRequest(ctx: GitHubEventContext): Promise<void> {
  const scope = makeScope(ctx);
  const pull = readPull(ctx.payload.pull_request);
  const action = ctx.action ?? "";
  if (!scope || !pull) return;
  const event = describePullEvent(action, pull, scope.sender, str(ctx.payload.after) ?? "");
  if (!event) return;

  const tasks: Array<() => Promise<unknown>> = [];
  let threadId: string | null = null;
  if (!scope.repo.private) {
    tasks.push(async () => {
      const thread = await findOrCreateThread(scope, pull, {
        create: action !== "closed",
        starter: (current) => pullStarter(scope, current),
      });
      threadId = thread?.threadId ?? null;
      if (!thread) return;
      // A post created for an opening event already shows the PR in its starter message. The
      // step is still recorded, so a redelivery (which finds the thread through the PR body)
      // does not post the card after all.
      const skip = thread.created && OPENING.has(action);
      await scope.once("card", async () =>
        skip ? false : postToThread(scope.services, thread.threadId, eventCard(scope, pull, event, OPENING.has(action))),
      );
    });
    if (event.feed) {
      const verb = event.feed;
      tasks.push(() => scope.once("feed", () => postToChannel(scope.services, "gitFeed", feedLine(feedText(scope, pull, verb, event.actor)))));
    }
  }
  if (COLLISION_ACTIONS.has(action) && pull.state === "open") {
    // Runs after the thread step so a thread created by this delivery gets the warning too.
    // Private repositories and a failed thread step leave threadId null; the guard then
    // verifies the body's link itself before posting.
    tasks.push(() => checkCollisions(scope, pull, threadId));
  }
  await runAll(`pull_request.${action} ${scope.repo.fullName}#${pull.number}`, tasks);
}

const REVIEW_TEXT: Record<string, { text: string; color: number; feed: string | null }> = {
  approved: { text: "approved these changes", color: Colors.success, feed: "approved" },
  changes_requested: { text: "requested changes", color: Colors.failure, feed: "changes requested" },
  commented: { text: "reviewed", color: Colors.neutral, feed: null },
};

export function reviewCard(scope: Scope, pull: PullRequest, review: Review): MessagePayload | null {
  const kind = REVIEW_TEXT[review.state];
  if (!kind) return null;
  const body = plainExcerpt(review.body, 500);
  if (review.state === "commented" && !body) return null;
  return card({
    color: kind.color,
    blocks: [heading(scope, pull), `**${escapeMarkdown(review.author)}** ${kind.text}`, body],
    button: { label: "Open review", url: review.htmlUrl || pull.htmlUrl },
  });
}

export async function handleReview(ctx: GitHubEventContext): Promise<void> {
  const scope = makeScope(ctx);
  const pull = readPull(ctx.payload.pull_request);
  const review = readReview(ctx.payload.review);
  if (!scope || !pull || !review || scope.repo.private) return;
  const message = reviewCard(scope, pull, review);
  if (!message) return;
  const feed = REVIEW_TEXT[review.state]?.feed ?? null;

  const tasks: Array<() => Promise<unknown>> = [
    async () => {
      const thread = await findOrCreateThread(scope, pull, {
        create: pull.state === "open",
        starter: (current) => pullStarter(scope, current),
      });
      if (thread) await scope.once("card", () => postToThread(scope.services, thread.threadId, message));
    },
  ];
  if (feed) {
    tasks.push(() =>
      scope.once("feed", () => postToChannel(scope.services, "gitFeed", feedLine(feedText(scope, pull, feed, review.author)))),
    );
  }
  await runAll(`pull_request_review ${scope.repo.fullName}#${pull.number}`, tasks);
}

export async function handleCheckSuite(ctx: GitHubEventContext): Promise<void> {
  const scope = makeScope(ctx);
  const suite = readCheckSuite(ctx.payload.check_suite);
  if (!scope || !suite || scope.repo.private || !suite.conclusion) return;
  const outcome = REPORTED_CONCLUSIONS[suite.conclusion];
  if (!outcome) return;

  const tasks: Array<() => Promise<unknown>> = suite.pullNumbers.map((number) => async () => {
    const pull = await scope.api.pull(number);
    // A suite for an older commit than the PR head is stale news.
    if (!pull || pull.state !== "open" || pull.headSha !== suite.headSha) return;
    const threadId = await linkedThread(scope, pull.body);
    if (!threadId) return;
    const message = card({
      color: outcome.color,
      blocks: [
        heading(scope, pull),
        `Checks ${outcome.text} (${escapeMarkdown(suite.app)}) on ${code(shortSha(suite.headSha))}`,
      ],
      button: { label: "Open checks", url: `${pull.htmlUrl}/checks` },
    });
    await scope.once(`check:${number}`, () => postToThread(scope.services, threadId, message));
  });

  if (suite.pullNumbers.length === 0 && suite.headBranch === scope.repo.defaultBranch && suite.conclusion !== "success") {
    const commitUrl = `${scope.repo.htmlUrl}/commit/${suite.headSha}`;
    const text = `**${escapeMarkdown(scope.repo.name)}** checks ${outcome.text} on ${code(suite.headBranch)} (${escapeMarkdown(suite.app)}, ${link(shortSha(suite.headSha), commitUrl)})`;
    tasks.push(() => scope.once("feed", () => postToChannel(scope.services, "gitFeed", feedLine(text))));
  }
  await runAll(`check_suite ${scope.repo.fullName}`, tasks);
}
