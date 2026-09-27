/**
 * Pushing fresh metadata for a user who is not in the browser.
 *
 * ```mermaid
 * flowchart TD
 *   A[stored user] --> B{Discord refresh}
 *   B -- invalid_grant --> X[delete row: app revoked on Discord]
 *   B -- ok --> C[save rotated Discord refresh token]
 *   C --> D{GitHub refresh token?}
 *   D -- yes --> E{GitHub refresh}
 *   E -- bad_refresh_token --> F[unlink GitHub: metadata all zero]
 *   E -- ok --> G[save rotated token, re-read login]
 *   E -- other error --> H[keep stored login]
 *   D -- no --> H
 *   G & H & F --> I[read GitHub facts with the App]
 *   I --> J[PUT role connection]
 * ```
 *
 * Discord re-evaluates a member's linked roles only when the app PUTs new
 * metadata, so this runs after GitHub events (refreshByGitHubLogin, called by
 * the github module) and from the cron (refreshStale). Rotated refresh tokens
 * are written back even when a later step fails, because the old ones stop
 * working the moment the provider rotates them. updated_at records the
 * attempt, so a user who keeps failing moves to the back of the cron queue.
 */
import { errorText } from "../interactions.ts";
import type { LinkedRolesContext } from "./context.ts";
import { EMPTY_METADATA, roleConnectionBody, type MetadataValues } from "./metadata.ts";
import { OAuthError } from "./oauth.ts";
import type { LinkedUser } from "./store.ts";

export type RefreshStatus =
  /** Metadata pushed. */
  | "updated"
  /** The user revoked the app on Discord; their row was deleted. */
  | "revoked"
  /** No usable Discord refresh token is stored; nothing can be pushed. */
  | "no-token"
  /** No stored user has this GitHub login. */
  | "not-linked";

export interface RefreshResult {
  status: RefreshStatus;
  discordId?: string;
  githubLogin?: string | null;
  metadata?: MetadataValues;
}

export async function metadataFor(
  ctx: LinkedRolesContext,
  githubLogin: string | null,
  owner: boolean,
): Promise<MetadataValues> {
  if (!githubLogin) return { ...EMPTY_METADATA, owner };
  const facts = await ctx.stats().facts(githubLogin);
  return { merged_prs: facts.mergedPrs, org_member: facts.orgMember, maintainer: facts.maintainer, owner };
}

/** Refreshes one stored user. Throws on transient failures, after recording the attempt. */
export async function refreshUser(ctx: LinkedRolesContext, user: LinkedUser): Promise<RefreshResult> {
  const store = await ctx.store();
  const { discordId } = user;
  if (!user.discordRefreshToken) {
    // Missing, or sealed under an old SESSION_SECRET: clear it so the cron stops picking the row.
    await store.update(discordId, { discordRefreshToken: null }, ctx.nowSeconds());
    return { status: "no-token", discordId };
  }

  let discordTokens;
  try {
    discordTokens = await ctx.discord.refresh(user.discordRefreshToken);
  } catch (error) {
    if (error instanceof OAuthError && error.revoked) {
      await store.delete(discordId);
      return { status: "revoked", discordId };
    }
    await store.update(discordId, {}, ctx.nowSeconds());
    throw error;
  }

  const changes: { discordRefreshToken?: string | null; githubRefreshToken?: string | null; githubLogin?: string | null } =
    { discordRefreshToken: discordTokens.refreshToken ?? user.discordRefreshToken };
  let login = user.githubLogin;
  try {
    if (user.githubRefreshToken && login) {
      try {
        const githubTokens = await ctx.github.refresh(user.githubRefreshToken);
        changes.githubRefreshToken = githubTokens.refreshToken;
        const current = await ctx.github.login(githubTokens.accessToken);
        if (current !== login) {
          // Renamed on GitHub. linkGitHub also frees the login from any other row.
          await store.linkGitHub(discordId, current, githubTokens.refreshToken, ctx.nowSeconds());
          delete changes.githubRefreshToken;
          login = current;
        }
      } catch (error) {
        if (error instanceof OAuthError && error.revoked) {
          changes.githubLogin = null;
          changes.githubRefreshToken = null;
          login = null;
        } else {
          console.error(`linked-roles: GitHub refresh for ${discordId} failed, using the stored login:`, errorText(error));
        }
      }
    }
    const metadata = await metadataFor(ctx, login, user.owner);
    await ctx.discord.putRoleConnection(discordTokens.accessToken, ctx.env.APPLICATION_ID, roleConnectionBody(login, metadata));
    return { status: "updated", discordId, githubLogin: login, metadata };
  } finally {
    await store.update(discordId, changes, ctx.nowSeconds());
  }
}

/**
 * Refreshes the Discord user linked to a GitHub login, e.g. after one of
 * their pull requests was merged. Returns status "not-linked" when nobody
 * linked that login.
 */
export async function refreshByGitHubLogin(ctx: LinkedRolesContext, githubLogin: string): Promise<RefreshResult> {
  const user = await (await ctx.store()).getByGitHubLogin(githubLogin);
  if (!user) return { status: "not-linked", githubLogin };
  return refreshUser(ctx, user);
}

export interface BatchSummary {
  checked: number;
  updated: number;
  revoked: number;
  noToken: number;
  failed: number;
}

/** Refreshes up to batchSize users whose last attempt is older than staleAfterSeconds, one at a time. */
export async function refreshStale(ctx: LinkedRolesContext): Promise<BatchSummary> {
  const store = await ctx.store();
  const users = await store.stale(ctx.nowSeconds() - ctx.staleAfterSeconds, ctx.batchSize);
  const summary: BatchSummary = { checked: users.length, updated: 0, revoked: 0, noToken: 0, failed: 0 };
  for (const user of users) {
    try {
      const result = await refreshUser(ctx, user);
      if (result.status === "updated") summary.updated++;
      else if (result.status === "revoked") summary.revoked++;
      else summary.noToken++;
    } catch (error) {
      summary.failed++;
      console.error(`linked-roles: refresh of ${user.discordId} failed:`, errorText(error));
    }
  }
  return summary;
}
