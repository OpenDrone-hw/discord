/**
 * GitHub webhook module: pull requests, reviews, checks, issues, releases,
 * pushes and repository topic changes, posted into the Discord product
 * channels, their pull request and issue threads and #git-feed, plus the
 * KiCad collision guard and the linked-role refresh after merges and
 * organisation or team membership changes. Nothing is posted to
 * #announcements: people write that channel.
 *
 * | File              | Content                                                   |
 * |-------------------|-----------------------------------------------------------|
 * | pulls.ts          | pull_request, pull_request_review, check_suite            |
 * | issues.ts         | issues, issue_comment; issue threads (D1 github_issues)   |
 * | collisions.ts     | KiCad collision guard (.kicad_pcb, .kicad_sch)            |
 * | repository.ts     | release, repository (status-* topics), push               |
 * | thread-link.ts    | "Discussion:" line in PR bodies, thread creation          |
 * | deliveries.ts     | redelivery idempotency on X-GitHub-Delivery (D1)          |
 * | context.ts        | per-delivery scope, posting to channels and threads       |
 * | api.ts            | GitHub REST calls as the installation                     |
 * | format.ts         | escaping and Components V2 cards                          |
 * | payload.ts        | typed views of webhook payloads                           |
 * | linked-roles.ts   | linked-role refresh on merges and membership changes      |
 *
 * Feed mode: config/repos.json "feed" is "deploys" by default (only a push to
 * the default branch or a published release posts, one #git-feed line each);
 * a repository with "feed": "full" keeps the threads and cards above. See
 * gated().
 *
 * Kill switch (src/posting.ts): every posting handler is wrapped by gated().
 * While posting is off the delivery is recorded as skipped, nothing reaches
 * Discord, the KiCad guard still comments on GitHub, issue states stay
 * current in D1, and the webhook still answers 202. The linked-role refresh
 * handlers are not gated.
 *
 * Handlers run in waitUntil after the 202 reply and are cancelled 30 s after
 * it. Channel ids come from services.directory, never from constants.
 * Private repositories never post to Discord; the collision guard still
 * comments on their pull requests.
 *
 * GitHub App permissions, webhook events and the bot role's Discord
 * permissions: bot/README.md, "Configuration".
 *
 * D1: the binding DB holds github_deliveries (deliveries.ts), github_issues
 * (issues.ts) and bot_settings (src/posting.ts), each created on first use.
 * scheduled() prunes deliveries older than 7 days and unarchives the threads
 * of issues that are still open.
 *
 * Contract: src/registry.ts (GitHubHandler, GitHubEventContext).
 */
import { feedModeFor } from "../config.ts";
import { errorText } from "../interactions.ts";
import { postingEnabled } from "../posting.ts";
import type { BotModule, GitHubEventContext, GitHubHandler } from "../registry.ts";
import { storeFor } from "./deliveries.ts";
import { ISSUE_ACTIONS, handleIssue, handleIssueComment, issueStoreFor, trackIssueState, unarchiveOpenIssueThreads } from "./issues.ts";
import { PULL_ACTIONS, handleCheckSuite, handlePullRequest, handlePullRequestCollisionsOnly, handleReview } from "./pulls.ts";
import { refreshHandlers, type RefreshHandlerOptions } from "./linked-roles.ts";
import { handleDeployPush, handleDeployRelease, handlePush, handleRelease, handleRepositoryEdited } from "./repository.ts";

export interface GitHubModuleOptions {
  /** Options of the linked-role refresh handlers (tests pass a fake refresh). */
  linkedRoles?: RefreshHandlerOptions;
}

type Handle = (ctx: GitHubEventContext) => Promise<void>;

async function recordSkipped(ctx: GitHubEventContext): Promise<void> {
  const store = storeFor(ctx.services.env.DB);
  if (store && ctx.delivery) {
    await store.markSkipped(ctx.delivery, `${ctx.event}.${ctx.action ?? "-"}`).catch((error: unknown) => {
      console.error("could not record the skipped delivery:", errorText(error));
    });
  }
}

/**
 * Runs `handle` while posting is on. While it is off, records the delivery
 * as skipped and runs `whenOff` (GitHub-only or D1-only work), if any.
 *
 * Feed mode (config/repos.json "feed", per-repository override): with
 * "full" `handle` runs as it always did. With "deploys" `deploy` runs
 * instead (a #git-feed line for a push or release, GitHub-only work for a
 * pull request), or nothing when the event is not a deploy; the delivery is
 * then recorded as skipped. `deploy` runs only while posting is on.
 */
export function gated(event: string, actions: string[] | undefined, handle: Handle, whenOff?: Handle, deploy?: Handle): GitHubHandler {
  const feedHandle: Handle = async (ctx) => {
    const repo = ctx.payload.repository;
    const name = typeof repo === "object" && repo !== null ? (repo as { full_name?: unknown }).full_name : undefined;
    if (feedModeFor(typeof name === "string" ? name : "", ctx.services.directory.config) === "full") return handle(ctx);
    console.log(`feed is deploys only: ${ctx.event}.${ctx.action ?? "-"} delivery ${ctx.delivery ?? "?"} not posted`);
    if (deploy) return deploy(ctx);
    await recordSkipped(ctx);
    if (whenOff) await whenOff(ctx);
  };
  const gatedHandle: Handle = async (ctx) => {
    if (await postingEnabled(ctx.services.env)) return feedHandle(ctx);
    console.log(`discord posting is off: ${ctx.event}.${ctx.action ?? "-"} delivery ${ctx.delivery ?? "?"} skipped`);
    await recordSkipped(ctx);
    if (whenOff) await whenOff(ctx);
  };
  return actions ? { event, actions, handle: gatedHandle } : { event, handle: gatedHandle };
}

export function createGitHubModule(options: GitHubModuleOptions = {}): BotModule {
  return {
    name: "github",
    github: [
      gated("pull_request", PULL_ACTIONS, handlePullRequest, handlePullRequestCollisionsOnly),
      gated("pull_request_review", ["submitted"], handleReview),
      gated("check_suite", ["completed"], handleCheckSuite),
      gated("issues", ISSUE_ACTIONS, handleIssue, trackIssueState),
      gated("issue_comment", ["created"], handleIssueComment),
      gated("release", ["published"], handleRelease, undefined, handleDeployRelease),
      gated("repository", ["edited"], handleRepositoryEdited),
      gated("push", undefined, handlePush, undefined, handleDeployPush),
      ...refreshHandlers(options.linkedRoles),
    ],
    async scheduled(_controller, services) {
      const store = storeFor(services.env.DB);
      if (store) {
        try {
          await store.prune();
        } catch (error) {
          console.error("github delivery prune failed:", errorText(error));
        }
      }
      const issues = issueStoreFor(services.env.DB);
      if (!issues || !(await postingEnabled(services.env))) return;
      try {
        await unarchiveOpenIssueThreads(services, issues);
      } catch (error) {
        console.error("issue thread unarchive failed:", errorText(error));
      }
    },
  };
}

export const githubModule: BotModule = createGitHubModule();
