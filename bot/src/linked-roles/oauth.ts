/**
 * OAuth2 for the two providers and the user-token calls made with the result.
 *
 * | Provider | Authorize                               | Token endpoint                             | Scopes                          |
 * |----------|-----------------------------------------|--------------------------------------------|---------------------------------|
 * | Discord  | https://discord.com/oauth2/authorize    | POST https://discord.com/api/v10/oauth2/token | identify role_connections.write |
 * | Discord (Early Bird) | same                        | same                                       | identify guilds.join            |
 * | GitHub   | https://github.com/login/oauth/authorize | POST https://github.com/login/oauth/access_token | none (GitHub App user token) |
 *
 * Discord refresh tokens rotate on every refresh; GitHub App user refresh
 * tokens rotate too when "Expire user authorization tokens" is on, and are
 * absent when it is off. Error messages name the provider, HTTP status and
 * OAuth error code, never a token or code.
 */
import { API_BASE, DiscordClient, type FetchLike } from "../discord.ts";
import { GITHUB_API, GITHUB_USER_AGENT, githubRequest } from "../github.ts";
import type { RoleConnectionBody } from "./metadata.ts";

export const DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
export const DISCORD_TOKEN_URL = `${API_BASE}/oauth2/token`;
export const DISCORD_SCOPES: readonly string[] = ["identify", "role_connections.write"];
export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";

export class OAuthError extends Error {
  readonly provider: "discord" | "github";
  readonly status: number;
  /** OAuth error code, e.g. "invalid_grant" or "bad_refresh_token". */
  readonly code: string | undefined;

  constructor(provider: "discord" | "github", status: number, code: string | undefined, what: string) {
    super(`${provider} ${what} failed with ${status}${code ? ` (${code})` : ""}`);
    this.name = "OAuthError";
    this.provider = provider;
    this.status = status;
    this.code = code;
  }

  /** The grant is gone for good (revoked, expired, already used), as opposed to a transient failure. */
  get revoked(): boolean {
    if (this.provider === "discord") return this.code === "invalid_grant";
    return this.code === "bad_refresh_token" || this.code === "bad_verification_code";
  }
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  scope: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function postForm(
  fetchFn: FetchLike,
  url: string,
  params: Record<string, string>,
): Promise<{ status: number; data: unknown }> {
  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": GITHUB_USER_AGENT,
    },
    body: new URLSearchParams(params).toString(),
  });
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { status: response.status, data };
}

function tokenSet(provider: "discord" | "github", status: number, data: unknown, what: string): TokenSet {
  const error = isRecord(data) && typeof data.error === "string" ? data.error : undefined;
  if (status < 200 || status >= 300 || error || !isRecord(data) || typeof data.access_token !== "string") {
    throw new OAuthError(provider, status, error, what);
  }
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : null,
    scope: typeof data.scope === "string" ? data.scope : "",
  };
}

export interface DiscordUser {
  id: string;
  username: string;
  /** Display name, when the user set one. */
  globalName: string | null;
}

/** "Display (@username)", or "@username" without a display name. */
export function discordLabel(user: Pick<DiscordUser, "username" | "globalName">): string {
  return user.globalName ? `${user.globalName} (@${user.username})` : `@${user.username}`;
}

export interface OAuthClientOptions {
  fetch: FetchLike;
  clientId: string;
  clientSecret: string;
}

export class DiscordOAuth {
  readonly #options: OAuthClientOptions;

  constructor(options: OAuthClientOptions) {
    this.#options = options;
  }

  authorizeUrl(redirectUri: string, state: string, scopes: readonly string[] = DISCORD_SCOPES): string {
    const url = new URL(DISCORD_AUTHORIZE_URL);
    url.searchParams.set("client_id", this.#options.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", scopes.join(" "));
    url.searchParams.set("state", state);
    // Always show the authorization screen: it names the account signed in to
    // discord.com in this browser and offers "Not you?" to switch.
    url.searchParams.set("prompt", "consent");
    return url.toString();
  }

  async #token(params: Record<string, string>, what: string): Promise<TokenSet> {
    const { status, data } = await postForm(this.#options.fetch, DISCORD_TOKEN_URL, {
      client_id: this.#options.clientId,
      client_secret: this.#options.clientSecret,
      ...params,
    });
    return tokenSet("discord", status, data, what);
  }

  async exchangeCode(code: string, redirectUri: string, scopes: readonly string[] = DISCORD_SCOPES): Promise<TokenSet> {
    const tokens = await this.#token({ grant_type: "authorization_code", code, redirect_uri: redirectUri }, "code exchange");
    const granted = new Set(tokens.scope.split(/\s+/));
    const missing = scopes.filter((s) => !granted.has(s));
    if (missing.length > 0) throw new OAuthError("discord", 200, "missing_scope", `scope ${missing.join(" ")}`);
    return tokens;
  }

  refresh(refreshToken: string): Promise<TokenSet> {
    return this.#token({ grant_type: "refresh_token", refresh_token: refreshToken }, "token refresh");
  }

  #client(): DiscordClient {
    // A fresh client per call: rate-limit state belongs to each user's token.
    return new DiscordClient({ fetch: this.#options.fetch });
  }

  /** The user the access token belongs to: the account signed in to discord.com in the browser. */
  async currentUser(accessToken: string): Promise<DiscordUser> {
    const user = await this.#client().request<Record<string, unknown>>("GET", "/users/@me", { bearer: accessToken });
    if (!isRecord(user) || typeof user.id !== "string" || !/^\d{15,25}$/.test(user.id)) {
      throw new Error("Discord /users/@me returned no user id");
    }
    const username = typeof user.username === "string" && user.username ? user.username : user.id;
    const globalName = typeof user.global_name === "string" && user.global_name ? user.global_name : null;
    return { id: user.id, username, globalName };
  }

  putRoleConnection(accessToken: string, applicationId: string, body: RoleConnectionBody): Promise<unknown> {
    return this.#client().request("PUT", `/users/@me/applications/${applicationId}/role-connection`, {
      bearer: accessToken,
      body,
    });
  }
}

export class GitHubOAuth {
  readonly #options: OAuthClientOptions;
  readonly #apiBase: string;

  constructor(options: OAuthClientOptions & { apiBase?: string }) {
    this.#options = options;
    this.#apiBase = options.apiBase ?? GITHUB_API;
  }

  authorizeUrl(redirectUri: string, state: string): string {
    const url = new URL(GITHUB_AUTHORIZE_URL);
    url.searchParams.set("client_id", this.#options.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("allow_signup", "false");
    return url.toString();
  }

  async #token(params: Record<string, string>, what: string): Promise<TokenSet> {
    const { status, data } = await postForm(this.#options.fetch, GITHUB_TOKEN_URL, {
      client_id: this.#options.clientId,
      client_secret: this.#options.clientSecret,
      ...params,
    });
    return tokenSet("github", status, data, what);
  }

  exchangeCode(code: string, redirectUri: string): Promise<TokenSet> {
    return this.#token({ code, redirect_uri: redirectUri }, "code exchange");
  }

  refresh(refreshToken: string): Promise<TokenSet> {
    return this.#token({ grant_type: "refresh_token", refresh_token: refreshToken }, "token refresh");
  }

  /** Login of the user the token belongs to. */
  async login(accessToken: string): Promise<string> {
    const user = await githubRequest<{ login?: unknown }>(
      this.#options.fetch,
      `Bearer ${accessToken}`,
      "GET",
      "/user",
      {},
      this.#apiBase,
    );
    if (!isRecord(user) || typeof user.login !== "string" || !GITHUB_LOGIN.test(user.login)) {
      throw new Error("GitHub /user returned no valid login");
    }
    return user.login;
  }
}

/**
 * GitHub usernames: letters, digits and hyphens, at most 39 characters. Older
 * accounts may break the current hyphen rules, so only the character set and
 * length are checked; that is enough to keep a login out of search syntax.
 */
export const GITHUB_LOGIN = /^[A-Za-z0-9-]{1,39}$/;
