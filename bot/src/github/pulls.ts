/**
 * Pull request and check suite events. Pull requests post nothing to
 * Discord: no thread, no card, no #git-feed line.
 *
 * | Event.action                                     | Does                                  |
 * |--------------------------------------------------|---------------------------------------|
 * | pull_request opened, reopened, ready_for_review, | KiCad collision guard (PR comment on  |
 * | synchronize                                      | GitHub only)                          |
 * | check_suite.completed                            | #git-feed line for a failed suite on  |
 * |                                                  | the default branch outside any PR     |
 *
 * Private repositories post nothing to Discord.
 */
import type { GitHubEventContext } from "../registry.ts";
import { checkCollisions } from "./collisions.ts";
import { makeScope, postToChannel } from "./context.ts";
import { code, escapeMarkdown, feedLine, link, shortSha } from "./format.ts";
import { readCheckSuite, readPull } from "./payload.ts";

export const PULL_ACTIONS = ["opened", "reopened", "ready_for_review", "synchronize"];
/** Default-branch check conclusions worth a #git-feed line. */
export const REPORTED_CONCLUSIONS: Record<string, string> = {
  failure: "failed",
  timed_out: "timed out",
  action_required: "need action",
  startup_failure: "failed to start",
};

export async function handlePullRequest(ctx: GitHubEventContext): Promise<void> {
  const scope = makeScope(ctx);
  const pull = readPull(ctx.payload.pull_request);
  if (!scope || !pull || pull.state !== "open") return;
  await checkCollisions(scope, pull);
}

export async function handleCheckSuite(ctx: GitHubEventContext): Promise<void> {
  const scope = makeScope(ctx);
  const suite = readCheckSuite(ctx.payload.check_suite);
  if (!scope || !suite || scope.repo.private || !suite.conclusion) return;
  const verb = REPORTED_CONCLUSIONS[suite.conclusion];
  if (!verb || suite.pullNumbers.length > 0 || suite.headBranch !== scope.repo.defaultBranch) return;

  const commitUrl = `${scope.repo.htmlUrl}/commit/${suite.headSha}`;
  const text = `**${escapeMarkdown(scope.repo.name)}** checks ${verb} on ${code(suite.headBranch)} (${escapeMarkdown(suite.app)}, ${link(shortSha(suite.headSha), commitUrl)})`;
  await scope.once("feed", () => postToChannel(scope.services, "gitFeed", feedLine(text)));
}
