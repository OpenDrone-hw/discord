/**
 * The browser flow behind Discord's Linked Roles verification URL.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant B as Browser
 *   participant W as Worker
 *   participant D as Discord
 *   participant G as GitHub
 *   B->>W: GET /linked-roles
 *   W-->>B: 302 Discord authorize, cookie {step discord, state}
 *   B->>D: approve identify + role_connections.write
 *   D-->>B: 302 /linked-roles/discord/callback?code&state
 *   B->>W: callback + cookie
 *   W->>D: exchange code, GET /users/@me
 *   W->>W: D1: store sealed Discord refresh token
 *   W-->>B: 302 GitHub authorize, cookie {step github, state, Discord id + access token}
 *   B->>G: approve
 *   G-->>B: 302 /linked-roles/github/callback?code&state
 *   B->>W: callback + cookie
 *   W->>G: exchange code, GET /user (login)
 *   W->>W: D1: store login + sealed GitHub refresh token
 *   W->>G: facts via the App installation
 *   W->>D: PUT role connection (platform GitHub)
 *   W-->>B: 200 result page, cookie cleared
 * ```
 *
 * Every callback checks the cookie's step, expiry and state before using the
 * code. Redirect URIs are built from the request origin, so they must match
 * the URLs registered in the Discord Developer Portal and the GitHub App.
 * Provider error text is never reflected into the page.
 */
import { errorText } from "../interactions.ts";
import type { LinkedRolesContext } from "./context.ts";
import { randomToken } from "./crypto.ts";
import { roleConnectionBody } from "./metadata.ts";
import { OAuthError } from "./oauth.ts";
import { metadataFor } from "./refresh.ts";
import { clearedCookie, readSession, SESSION_TTL_SECONDS, sessionCookie, stateMatches } from "./session.ts";

export const DISCORD_CALLBACK_PATH = "/linked-roles/discord/callback";
export const GITHUB_CALLBACK_PATH = "/linked-roles/github/callback";

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A minimal result page. `lines` are plain text and escaped here. */
export function page(status: number, title: string, lines: string[], cookie?: string): Response {
  const body = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    "<style>body{font-family:system-ui,sans-serif;background:#111;color:#eee;max-width:36rem;margin:4rem auto;padding:0 1rem;line-height:1.5}</style>",
    `</head><body><h1>${escapeHtml(title)}</h1>`,
    ...lines.map((line) => `<p>${escapeHtml(line)}</p>`),
    "</body></html>",
  ].join("\n");
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS });
  if (cookie) headers.append("Set-Cookie", cookie);
  return new Response(body, { status, headers });
}

function redirect(location: string, cookie: string): Response {
  const headers = new Headers({ Location: location, ...SECURITY_HEADERS });
  headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

const START_AGAIN = "Start again from the server's Linked Roles menu in Discord.";

function expired(): Response {
  return page(400, "Link expired", ["This link is no longer valid.", START_AGAIN], clearedCookie());
}

function cancelled(provider: string): Response {
  return page(400, `${provider} authorization cancelled`, ["Nothing was linked.", START_AGAIN], clearedCookie());
}

function failed(provider: string): Response {
  return page(400, `${provider} authorization failed`, ["Nothing was linked.", START_AGAIN], clearedCookie());
}

/** GET /linked-roles: start the Discord step. */
export async function start(ctx: LinkedRolesContext, request: Request): Promise<Response> {
  const origin = new URL(request.url).origin;
  const state = randomToken();
  const cookie = await sessionCookie(await ctx.sessionKey(), {
    step: "discord",
    state,
    exp: ctx.nowSeconds() + SESSION_TTL_SECONDS,
  });
  return redirect(ctx.discord.authorizeUrl(origin + DISCORD_CALLBACK_PATH, state), cookie);
}

/** GET /linked-roles/discord/callback: store the Discord grant, then start the GitHub step. */
export async function discordCallback(ctx: LinkedRolesContext, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const key = await ctx.sessionKey();
  const session = await readSession(key, request, "discord", ctx.nowSeconds());
  if (!session) return expired();
  if (!stateMatches(session.state, url.searchParams.get("state"))) return expired();
  if (url.searchParams.has("error")) return cancelled("Discord");
  const code = url.searchParams.get("code");
  if (!code) return failed("Discord");

  let tokens;
  try {
    tokens = await ctx.discord.exchangeCode(code, url.origin + DISCORD_CALLBACK_PATH);
  } catch (error) {
    if (!(error instanceof OAuthError)) throw error;
    console.error("linked-roles: Discord code exchange failed:", errorText(error));
    return failed("Discord");
  }
  if (!tokens.refreshToken) {
    console.error("linked-roles: Discord returned no refresh token");
    return failed("Discord");
  }
  const discordId = await ctx.discord.currentUserId(tokens.accessToken);
  await (await ctx.store()).saveDiscord(discordId, tokens.refreshToken, ctx.nowSeconds());

  const state = randomToken();
  const cookie = await sessionCookie(key, {
    step: "github",
    state,
    exp: ctx.nowSeconds() + SESSION_TTL_SECONDS,
    discordId,
    discordAccessToken: tokens.accessToken,
  });
  return redirect(ctx.github.authorizeUrl(url.origin + GITHUB_CALLBACK_PATH, state), cookie);
}

/** GET /linked-roles/github/callback: link the GitHub login and push the first metadata. */
export async function githubCallback(ctx: LinkedRolesContext, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const session = await readSession(await ctx.sessionKey(), request, "github", ctx.nowSeconds());
  if (!session?.discordId || !session.discordAccessToken) return expired();
  if (!stateMatches(session.state, url.searchParams.get("state"))) return expired();
  if (url.searchParams.has("error")) return cancelled("GitHub");
  const code = url.searchParams.get("code");
  if (!code) return failed("GitHub");

  let login: string;
  let refreshToken: string | null;
  try {
    const tokens = await ctx.github.exchangeCode(code, url.origin + GITHUB_CALLBACK_PATH);
    refreshToken = tokens.refreshToken;
    login = await ctx.github.login(tokens.accessToken);
  } catch (error) {
    if (!(error instanceof OAuthError)) throw error;
    console.error("linked-roles: GitHub code exchange failed:", errorText(error));
    return failed("GitHub");
  }

  const store = await ctx.store();
  const discordId = session.discordId;
  await store.linkGitHub(discordId, login, refreshToken, ctx.nowSeconds());
  const owner = (await store.get(discordId))?.owner ?? false;

  let metadata;
  try {
    metadata = await metadataFor(ctx, login, owner);
  } catch (error) {
    console.error(`linked-roles: reading GitHub data for ${discordId} failed:`, errorText(error));
    // updated_at 0 puts the user first in the next cron run.
    await store.update(discordId, {}, 0);
    return page(
      502,
      "Linked, roles pending",
      [
        `Your Discord account is linked to GitHub account ${login}.`,
        "GitHub data could not be read just now. The bot retries on its next scheduled run, within 6 hours.",
      ],
      clearedCookie(),
    );
  }

  await ctx.discord.putRoleConnection(session.discordAccessToken, ctx.env.APPLICATION_ID, roleConnectionBody(login, metadata));
  return page(
    200,
    "Linked",
    [
      `Discord is now linked to GitHub account ${login}.`,
      `Merged pull requests in ${ctx.org}: ${metadata.merged_prs}. Organisation member: ${metadata.org_member ? "yes" : "no"}. Maintainer: ${metadata.maintainer ? "yes" : "no"}.`,
      "You can close this tab. In Discord, claim the linked roles whose requirements these values meet.",
    ],
    clearedCookie(),
  );
}
