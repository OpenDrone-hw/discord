/**
 * Linked roles module: Discord and GitHub OAuth, role connection metadata,
 * refresh-token storage in D1 and the periodic metadata refresh.
 *
 * | Part                         | File        |
 * |------------------------------|-------------|
 * | Metadata schema and values   | metadata.ts |
 * | Browser flow (three routes)  | routes.ts   |
 * | Session cookie               | session.ts  |
 * | Provider OAuth calls         | oauth.ts    |
 * | GitHub facts via the App     | stats.ts    |
 * | D1 users, sealed tokens      | store.ts    |
 * | Key derivation, AES-GCM      | crypto.ts   |
 * | Refresh without the browser  | refresh.ts  |
 *
 * For the github module: call refreshLinkedUser(services, login) after an
 * event that changes a user's facts (a merged pull request, an organisation
 * or team membership change); after a merge pass known = { minMergedPrs: 1 },
 * because GitHub search may not count the merge yet. It returns status "not-linked" when nobody
 * linked that login, and throws on transient failures. It makes about seven
 * subrequests, well inside the 30 s waitUntil budget. Calls for the same user
 * may overlap: a per-row lease runs them one after the other (the second waits
 * up to 10 s, then returns status "busy").
 *
 * The cron (wrangler.toml, every 6 h) refreshes at most DEFAULT_BATCH_SIZE
 * users whose last refresh is older than 24 h, oldest first.
 *
 * Contract: src/registry.ts (HttpRoute, BotModule.scheduled,
 * BotModule.roleConnectionMetadata).
 */
import type { BotModule } from "../registry.ts";
import type { Services } from "../services.ts";
import { LinkedRolesContext, type LinkedRolesOptions } from "./context.ts";
import { METADATA_RECORDS } from "./metadata.ts";
import { refreshByGitHubLogin, refreshStale, type KnownFacts, type RefreshResult } from "./refresh.ts";
import { discordCallback, githubCallback, start } from "./routes.ts";

export type { LinkedRolesOptions } from "./context.ts";
export type { BatchSummary, KnownFacts, RefreshResult, RefreshStatus } from "./refresh.ts";
export { METADATA_RECORDS } from "./metadata.ts";

export function createLinkedRolesModule(options: LinkedRolesOptions = {}): BotModule {
  const context = (services: Services) => new LinkedRolesContext(services, options);
  return {
    name: "linked-roles",
    routes: [
      { route: "GET /linked-roles", handle: (request, services) => start(context(services), request) },
      {
        route: "GET /linked-roles/discord/callback",
        handle: (request, services) => discordCallback(context(services), request),
      },
      {
        route: "GET /linked-roles/github/callback",
        handle: (request, services) => githubCallback(context(services), request),
      },
    ],
    async scheduled(_controller, services) {
      const s = await refreshStale(context(services));
      console.log(
        `linked-roles refresh: ${s.checked} checked, ${s.updated} updated, ${s.revoked} revoked, ${s.noToken} without token, ${s.skipped} skipped, ${s.failed} failed`,
      );
    },
    roleConnectionMetadata: METADATA_RECORDS,
  };
}

export const linkedRolesModule: BotModule = createLinkedRolesModule();

/**
 * Pushes fresh metadata for the Discord user linked to `githubLogin`
 * (case-insensitive). For the github module, e.g. after a merge, with
 * `known.minMergedPrs` set to 1 because search may not count the merge yet.
 */
export function refreshLinkedUser(
  services: Services,
  githubLogin: string,
  options: LinkedRolesOptions = {},
  known: KnownFacts = {},
): Promise<RefreshResult> {
  return refreshByGitHubLogin(new LinkedRolesContext(services, options), githubLogin, known);
}
