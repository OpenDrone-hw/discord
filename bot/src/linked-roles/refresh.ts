/**
 * Pushing fresh metadata for a user who is not in the browser.
 *
 * ```mermaid
 * flowchart TD
 *   L{take the row's refresh lease} -- held by another refresh, 10 s --> Y[busy: nothing changed]
 *   L -- taken --> A[re-read the row]
 *   A --> B{Discord refresh}
 *   B -- invalid_grant, token unchanged --> X[clear Discord token: app revoked; row, GitHub link and owner kept]
 *   B -- invalid_grant, token replaced by a new link --> S[superseded: nothing changed]
 *   B -- ok --> C[save rotated Discord refresh token at once]
 *   C --> D{GitHub refresh token?}
 *   D -- yes --> E{GitHub refresh}
 *   E -- bad_refresh_token --> F[unlink GitHub unless a new link replaced it]
 *   E -- ok --> G[save rotated token at once, re-read login]
 *   E -- other error --> H[keep stored login]
 *   D -- no --> H
 *   G & H & F --> I[read GitHub facts with the App]
 *   I --> J[PUT role connection]
 *   J --> U[release the lease]
 * ```
 *
 * Discord re-evaluates a member's linked roles only when the app PUTs new
 * metadata, so this runs after GitHub events (refreshByGitHubLogin, called by
 * the github module) and from the cron (refreshStale).
 *
 * Discord and GitHub refresh tokens are single use. Two refreshes of one user
 * at the same time (two merges close together, a webhook during the cron)
 * would both spend the same token and the loser would read invalid_grant as a
 * revoked app. The lease (UserStore.tryLock) runs them one after the other,
 * and the second re-reads the row the first left. Token writes are
 * compare-and-set against the ciphertext read under the lease, so a browser
 * link that lands meanwhile (it does not take the lease) always wins.
 * Rotated tokens are saved right after each provider call, because the old
 * ones stop working the moment the provider rotates them. updated_at records
 * the attempt, so a user who keeps failing moves to the back of the cron queue.
 */
import { errorText } from "../interactions.ts";
import { LOCK_POLL_MS, type LinkedRolesContext } from "./context.ts";
import { EMPTY_METADATA, roleConnectionBody, type MetadataValues } from "./metadata.ts";
import { OAuthError } from "./oauth.ts";
import type { LinkedUser, UserStore } from "./store.ts";

export type RefreshStatus =
  /** Metadata pushed. */
  | "updated"
  /** The user revoked the app on Discord; their Discord token was cleared, the row kept. */
  | "revoked"
  /** No usable Discord refresh token is stored; nothing can be pushed. */
  | "no-token"
  /** No stored user has this GitHub login, or the row is gone. */
  | "not-linked"
  /** Another refresh of this user held the lease for the whole wait; nothing changed. */
  | "busy"
  /** A new browser link replaced the Discord token during the refresh; nothing changed, the link pushed its own metadata. */
  | "superseded";

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

/** Takes the user's refresh lease, polling up to ctx.lockWaitMs. */
async function acquire(ctx: LinkedRolesContext, store: UserStore, discordId: string): Promise<"locked" | "busy" | "missing"> {
  const attempts = Math.max(1, Math.ceil(ctx.lockWaitMs / LOCK_POLL_MS));
  for (let i = 0; ; i++) {
    if (await store.tryLock(discordId, ctx.nowSeconds(), ctx.lockLeaseSeconds)) return "locked";
    if (i === 0 && !(await store.get(discordId))) return "missing";
    if (i + 1 >= attempts) return "busy";
    await ctx.sleep(LOCK_POLL_MS);
  }
}

/**
 * Refreshes one stored user. Only `user.discordId` is used: the row is
 * re-read under the lease, so a row the cron read earlier cannot bring back
 * old tokens. Throws on transient failures, after recording the attempt.
 */
export async function refreshUser(ctx: LinkedRolesContext, user: Pick<LinkedUser, "discordId">): Promise<RefreshResult> {
  const store = await ctx.store();
  const { discordId } = user;
  const lease = await acquire(ctx, store, discordId);
  if (lease === "missing") return { status: "not-linked", discordId };
  if (lease === "busy") return { status: "busy", discordId };
  try {
    const current = await store.get(discordId);
    if (!current) return { status: "not-linked", discordId };
    return await refreshLocked(ctx, store, current);
  } finally {
    await store.unlock(discordId);
  }
}

async function refreshLocked(ctx: LinkedRolesContext, store: UserStore, user: LinkedUser): Promise<RefreshResult> {
  const { discordId, sealed } = user;
  if (!user.discordRefreshToken) {
    // Missing, or sealed under an old SESSION_SECRET: clear it so the cron stops picking the row.
    await store.update(discordId, { discordRefreshToken: null }, ctx.nowSeconds(), { discord: sealed.discord });
    return { status: "no-token", discordId };
  }

  let discordTokens;
  try {
    discordTokens = await ctx.discord.refresh(user.discordRefreshToken);
  } catch (error) {
    if (error instanceof OAuthError && error.revoked) {
      // Under the lease no other refresh spent this token, so the grant is
      // gone, unless a browser link replaced the token meanwhile.
      const written = await store.update(discordId, { discordRefreshToken: null }, ctx.nowSeconds(), { discord: sealed.discord });
      return { status: written.discord ? "revoked" : "superseded", discordId };
    }
    await store.update(discordId, {}, ctx.nowSeconds());
    throw error;
  }

  try {
    if (discordTokens.refreshToken) {
      await store.update(discordId, { discordRefreshToken: discordTokens.refreshToken }, ctx.nowSeconds(), { discord: sealed.discord });
    }
    let login = user.githubLogin;
    if (user.githubRefreshToken && login) {
      login = await refreshGitHub(ctx, store, user, login);
    }
    const metadata = await metadataFor(ctx, login, user.owner);
    await ctx.discord.putRoleConnection(discordTokens.accessToken, ctx.env.APPLICATION_ID, roleConnectionBody(login, metadata));
    return { status: "updated", discordId, githubLogin: login, metadata };
  } finally {
    await store.update(discordId, {}, ctx.nowSeconds());
  }
}

/** Rotates the GitHub token and returns the login to report. */
async function refreshGitHub(ctx: LinkedRolesContext, store: UserStore, user: LinkedUser, login: string): Promise<string | null> {
  const { discordId, sealed } = user;
  const storedLogin = async () => (await store.get(discordId))?.githubLogin ?? null;
  let githubTokens;
  try {
    githubTokens = await ctx.github.refresh(user.githubRefreshToken!);
  } catch (error) {
    if (error instanceof OAuthError && error.revoked) {
      const written = await store.update(discordId, { githubLogin: null, githubRefreshToken: null }, ctx.nowSeconds(), {
        github: sealed.github,
      });
      return written.github ? null : storedLogin();
    }
    console.error(`linked-roles: GitHub refresh for ${discordId} failed, using the stored login:`, errorText(error));
    return login;
  }
  const written = await store.update(discordId, { githubRefreshToken: githubTokens.refreshToken }, ctx.nowSeconds(), {
    github: sealed.github,
  });
  // A browser link replaced the GitHub link during the refresh; report what it stored.
  if (!written.github) return storedLogin();
  try {
    const current = await ctx.github.login(githubTokens.accessToken);
    if (current !== login) {
      // Renamed on GitHub. linkGitHub also frees the login from any other row.
      await store.linkGitHub(discordId, current, githubTokens.refreshToken, ctx.nowSeconds());
    }
    return current;
  } catch (error) {
    console.error(`linked-roles: GitHub login lookup for ${discordId} failed, using the stored login:`, errorText(error));
    return login;
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
  /** busy, superseded or not-linked: another refresh or a new link handled the user. */
  skipped: number;
  failed: number;
}

/** Refreshes up to batchSize users whose last attempt is older than staleAfterSeconds, one at a time. */
export async function refreshStale(ctx: LinkedRolesContext): Promise<BatchSummary> {
  const store = await ctx.store();
  const users = await store.stale(ctx.nowSeconds() - ctx.staleAfterSeconds, ctx.batchSize);
  const summary: BatchSummary = { checked: users.length, updated: 0, revoked: 0, noToken: 0, skipped: 0, failed: 0 };
  for (const user of users) {
    try {
      const result = await refreshUser(ctx, user);
      if (result.status === "updated") summary.updated++;
      else if (result.status === "revoked") summary.revoked++;
      else if (result.status === "no-token") summary.noToken++;
      else summary.skipped++;
    } catch (error) {
      summary.failed++;
      console.error(`linked-roles: refresh of ${user.discordId} failed:`, errorText(error));
    }
  }
  return summary;
}
