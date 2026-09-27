/**
 * GitHub webhook module: pull requests, reviews, checks, releases, pushes and
 * repository topic changes, posted into the Discord product channels, their
 * pull request threads and the channels named in config/repos.json, plus the KiCad collision guard and the linked-role
 * refresh after merges and organisation or team membership changes.
 *
 * | File              | Content                                                   |
 * |-------------------|-----------------------------------------------------------|
 * | pulls.ts          | pull_request, pull_request_review, check_suite            |
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
 * Handlers run in waitUntil after the 202 reply and are cancelled 30 s after
 * it. Channel ids come from services.directory, never from constants.
 * Private repositories never post to Discord; the collision guard still
 * comments on their pull requests.
 *
 * GitHub App permissions, webhook events and the bot role's Discord
 * permissions: bot/README.md, "2. GitHub App".
 *
 * D1: the binding DB holds the github_deliveries table (deliveries.ts,
 * TABLE_SQL), created on first use; scheduled() prunes rows older than 7 days.
 *
 * Contract: src/registry.ts (GitHubHandler, GitHubEventContext).
 */
import type { BotModule } from "../registry.ts";
import { errorText } from "../interactions.ts";
import { storeFor } from "./deliveries.ts";
import { PULL_ACTIONS, handleCheckSuite, handlePullRequest, handleReview } from "./pulls.ts";
import { refreshHandlers, type RefreshHandlerOptions } from "./linked-roles.ts";
import { handlePush, handleRelease, handleRepositoryEdited } from "./repository.ts";

export interface GitHubModuleOptions {
  /** Options of the linked-role refresh handlers (tests pass a fake refresh). */
  linkedRoles?: RefreshHandlerOptions;
}

export function createGitHubModule(options: GitHubModuleOptions = {}): BotModule {
  return {
    name: "github",
    github: [
      { event: "pull_request", actions: PULL_ACTIONS, handle: handlePullRequest },
      { event: "pull_request_review", actions: ["submitted"], handle: handleReview },
      { event: "check_suite", actions: ["completed"], handle: handleCheckSuite },
      { event: "release", actions: ["published"], handle: handleRelease },
      { event: "repository", actions: ["edited"], handle: handleRepositoryEdited },
      { event: "push", handle: handlePush },
      ...refreshHandlers(options.linkedRoles),
    ],
    async scheduled(_controller, services) {
      const store = storeFor(services.env.DB);
      if (!store) return;
      try {
        await store.prune();
      } catch (error) {
        console.error("github delivery prune failed:", errorText(error));
      }
    },
  };
}

export const githubModule: BotModule = createGitHubModule();
