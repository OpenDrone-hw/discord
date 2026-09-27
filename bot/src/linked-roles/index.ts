/**
 * Linked roles module: Discord and GitHub OAuth, role connection metadata,
 * refresh-token storage in D1 (migrations/0001_linked_roles.sql) and the
 * periodic metadata refresh.
 *
 * Stub: the three routes answer 501 and no metadata is registered.
 * roleConnectionMetadata records are sent by scripts/register-metadata.ts
 * (Discord allows at most 5). scheduled() runs on the wrangler.toml cron.
 *
 * Contract: src/registry.ts (HttpRoute, BotModule.scheduled,
 * BotModule.roleConnectionMetadata).
 */
import type { BotModule, HttpRoute, ModuleRoute } from "../registry.ts";

const notSetUp = (route: ModuleRoute): HttpRoute => ({
  route,
  handle: () => new Response("Linked roles are not set up.", { status: 501 }),
});

export const linkedRolesModule: BotModule = {
  name: "linked-roles",
  routes: [
    notSetUp("GET /linked-roles"),
    notSetUp("GET /linked-roles/discord/callback"),
    notSetUp("GET /linked-roles/github/callback"),
  ],
  roleConnectionMetadata: [],
};
