/**
 * GitHub webhook module: pull requests, reviews, checks, releases and
 * repository topic changes, posted into the Discord forums and channels named
 * in config/repos.json.
 *
 * Stub: registers nothing. A handler is added as
 *
 *   github: [{
 *     event: "pull_request",
 *     actions: ["opened", "synchronize"],     // omit for every action
 *     handle: async ({ payload, services }) => { ... },
 *   }],
 *
 * Handlers run in waitUntil after the 202 reply and are cancelled 30 s after
 * it (Cloudflare's limit); longer work goes to a Queue or the cron trigger.
 * The installation id for
 * GitHub calls is payload.installation.id (services.github.request). Channel
 * and tag ids come from services.directory, never from constants.
 *
 * Contract: src/registry.ts (GitHubHandler, GitHubEventContext).
 */
import type { BotModule } from "../registry.ts";

export const githubModule: BotModule = {
  name: "github",
  github: [],
};
