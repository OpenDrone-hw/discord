import { describe, expect, it, vi } from "vitest";
import { COOKIE_NAME } from "../../src/linked-roles/session.ts";
import { escapeHtml } from "../../src/linked-roles/routes.ts";
import { BOT_TOKEN } from "../helpers.ts";
import { APP, BASE, ORG, continueUrl, cookieFrom, get, harness, link, type Harness } from "./harness.ts";

const DISCORD_ID = "123456789012345678";

/** Starts the flow and returns the Discord callback state and cookie. */
async function startFlow(h: Harness) {
  const response = await h.call(get("/linked-roles"));
  const location = new URL(response.headers.get("Location") ?? "");
  return { response, location, state: location.searchParams.get("state") ?? "", cookie: cookieFrom(response) };
}

/** Completes the Discord step and returns the GitHub callback state and cookie. */
async function throughDiscord(h: Harness, id = DISCORD_ID) {
  const s = await startFlow(h);
  h.providers.discordCodes.set("dcode", { id });
  const response = await h.call(get(`/linked-roles/discord/callback?code=dcode&state=${s.state}`, s.cookie));
  const location = await continueUrl(response);
  return { response, location, state: location.searchParams.get("state") ?? "", cookie: cookieFrom(response) };
}

function quiet() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("GET /linked-roles", () => {
  it("redirects to Discord with the scopes, redirect URI and a state bound to a cookie", async () => {
    const h = await harness();
    const { response, location, state, cookie } = await startFlow(h);
    expect(response.status).toBe(302);
    expect(`${location.origin}${location.pathname}`).toBe("https://discord.com/oauth2/authorize");
    expect(Object.fromEntries(location.searchParams)).toEqual({
      client_id: "client",
      redirect_uri: `${BASE}/linked-roles/discord/callback`,
      response_type: "code",
      scope: "identify role_connections.write",
      state,
      prompt: "consent",
    });
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const setCookie = response.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(cookie.startsWith(`${COOKIE_NAME}=v1.`)).toBe(true);
    expect(cookie).not.toContain(state);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(h.providers.calls).toHaveLength(0);
  });
});

describe("full link", () => {
  it("links Discord to GitHub, stores sealed tokens and pushes the metadata", async () => {
    const h = await harness();
    h.providers.mergedPrs.set("alice", 3);
    h.providers.orgMembers.add("alice");
    h.providers.teams.set("maintainers", new Map([["alice", "active"]]));

    const discord = await throughDiscord(h);
    expect(discord.response.status).toBe(200);
    expect(`${discord.location.origin}${discord.location.pathname}`).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(discord.location.searchParams)).toEqual({
      client_id: "gh-client",
      redirect_uri: `${BASE}/linked-roles/github/callback`,
      state: discord.state,
      allow_signup: "false",
    });
    const tokenCall = h.providers.callsTo("POST", "discord.com/api/v10/oauth2/token")[0]!;
    expect(Object.fromEntries(new URLSearchParams(tokenCall.body))).toEqual({
      client_id: "client",
      client_secret: "client-secret",
      grant_type: "authorization_code",
      code: "dcode",
      redirect_uri: `${BASE}/linked-roles/discord/callback`,
    });
    expect(h.d1.row(DISCORD_ID)?.discord_refresh_token).toMatch(/^v1\./);

    h.providers.githubCodes.set("gcode", "alice");
    const done = await h.call(get(`/linked-roles/github/callback?code=gcode&state=${discord.state}`, discord.cookie));
    const html = await done.text();
    expect(done.status).toBe(200);
    expect(html).toContain(`Discord account @user${DISCORD_ID} is now linked to GitHub account alice`);
    expect(html).toContain("Merged pull requests in OpenDrone-hw: 3");
    expect(done.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(done.headers.get("Content-Security-Policy")).toContain("default-src 'none'");

    expect(h.providers.roleConnections.get(DISCORD_ID)).toEqual({
      platform_name: "GitHub",
      platform_username: "alice",
      metadata: { merged_prs: "3", org_member: "1", maintainer: "1", owner: "0" },
    });
    const put = h.providers.callsTo("PUT", `discord.com/api/v10/users/@me/applications/${APP}/role-connection`)[0]!;
    expect(put.headers.get("Authorization")).toMatch(/^Bearer dat-/);

    const search = h.providers.callsTo("GET", "api.github.com/search/issues")[0]!;
    expect(search.url.searchParams.get("q")).toBe(`is:pr is:merged org:${ORG} author:alice`);
    expect(search.headers.get("Authorization")).toBe("Bearer ghs_installation");
    expect(h.providers.callsTo("GET", `api.github.com/orgs/${ORG}/teams/maintainers/memberships/alice`)).toHaveLength(1);

    const row = h.d1.row(DISCORD_ID)!;
    expect(row.github_login).toBe("alice");
    expect(String(row.github_refresh_token)).toMatch(/^v1\./);
    const everything = JSON.stringify(row);
    for (const t of [...h.providers.discordRefresh.keys(), ...h.providers.githubRefresh.keys()]) {
      expect(everything).not.toContain(t);
    }
    // The stored tokens are the live ones.
    expect(h.providers.discordRefresh.size).toBe(1);
    expect(h.providers.githubRefresh.size).toBe(1);

    for (const call of h.providers.calls) expect(call.headers.get("Authorization") ?? "").not.toContain(BOT_TOKEN);
  });

  it("reports false facts for a non-member and a pending team invite, and reads the owner flag", async () => {
    const h = await harness();
    h.providers.teams.set("maintainers", new Map([["bob", "pending"]]));
    const discord = await throughDiscord(h, "999999999999999999");
    h.d1.sqlite.exec("UPDATE users SET owner = 1 WHERE discord_id = '999999999999999999'");
    h.providers.githubCodes.set("gcode", "bob");
    const done = await h.call(get(`/linked-roles/github/callback?code=gcode&state=${discord.state}`, discord.cookie));
    expect(done.status).toBe(200);
    expect(h.providers.roleConnections.get("999999999999999999")).toEqual({
      platform_name: "GitHub",
      platform_username: "bob",
      metadata: { merged_prs: "0", org_member: "0", maintainer: "0", owner: "1" },
    });
  });

  it("uses the maintainer team named in GITHUB_MAINTAINER_TEAM", async () => {
    const h = await harness({ GITHUB_MAINTAINER_TEAM: "core" });
    h.providers.teams.set("core", new Map([["alice", "active"]]));
    expect((await link(h, DISCORD_ID, "alice")).status).toBe(200);
    expect(h.providers.roleConnections.get(DISCORD_ID)?.metadata).toMatchObject({ maintainer: "1" });
    expect(h.providers.callsTo("GET", `api.github.com/orgs/${ORG}/teams/core/memberships/alice`)).toHaveLength(1);
  });

  it("moves a GitHub account to the Discord account that linked it last", async () => {
    const h = await harness();
    await link(h, "111111111111111111", "alice");
    await link(h, "222222222222222222", "Alice");
    expect(h.d1.row("111111111111111111")).toMatchObject({ github_login: null, updated_at: 0 });
    expect(h.d1.row("222222222222222222")).toMatchObject({ github_login: "Alice" });
  });

  it("reuses the org installation id across requests", async () => {
    const h = await harness();
    await link(h, "111111111111111111", "alice");
    await link(h, "222222222222222222", "bob");
    expect(h.providers.callsTo("GET", `api.github.com/orgs/${ORG}/installation`)).toHaveLength(1);
  });
});

describe("account check", () => {
  it("names the Discord account the browser authorised before sending anyone to GitHub", async () => {
    const h = await harness();
    h.providers.discordDisplayNames.set(DISCORD_ID, "Alice");
    const discord = await throughDiscord(h);
    const html = await discord.response.text();
    expect(discord.response.headers.get("Location")).toBeNull();
    expect(discord.response.headers.get("Cache-Control")).toBe("no-store");
    expect(html).toContain(`signed in to Discord as Alice (@user${DISCORD_ID})`);
    expect(html).toContain(`href="${BASE}/linked-roles"`);
    expect(html).toContain("Not you?");
    expect(h.providers.callsTo("POST", "github.com/login/oauth/access_token")).toHaveLength(0);
    expect(h.providers.roleConnections.size).toBe(0);
  });

  it("escapes a display name that contains markup", async () => {
    const h = await harness();
    h.providers.discordDisplayNames.set(DISCORD_ID, `<img src=x onerror="alert(1)">`);
    const html = await (await throughDiscord(h)).response.text();
    expect(html).not.toContain("<img");
    expect(html).toContain("&#60;img src=x onerror=&#34;alert(1)&#34;&#62;");
  });

  it("lets a member who authorised the wrong account start again and link the right one", async () => {
    const h = await harness();
    const WRONG = "888888888888888888";
    await throughDiscord(h, WRONG);
    h.providers.githubCodes.set("gcode", "alice");
    const right = await throughDiscord(h, DISCORD_ID);
    const done = await h.call(get(`/linked-roles/github/callback?code=gcode&state=${right.state}`, right.cookie));
    expect(done.status).toBe(200);
    expect(h.providers.roleConnections.has(WRONG)).toBe(false);
    expect(h.providers.roleConnections.get(DISCORD_ID)).toMatchObject({ platform_username: "alice" });
    expect(h.d1.row(WRONG)?.github_login ?? null).toBeNull();
  });
});

describe("callback checks", () => {
  it("refuses a Discord callback without the cookie, with a wrong state or a GitHub-step cookie", async () => {
    const h = await harness();
    const s = await startFlow(h);
    h.providers.discordCodes.set("dcode", { id: DISCORD_ID });
    expect((await h.call(get(`/linked-roles/discord/callback?code=dcode&state=${s.state}`))).status).toBe(400);
    expect((await h.call(get(`/linked-roles/discord/callback?code=dcode&state=wrong`, s.cookie))).status).toBe(400);
    expect((await h.call(get(`/linked-roles/discord/callback?code=dcode`, s.cookie))).status).toBe(400);
    const discord = await throughDiscord(h);
    expect((await h.call(get(`/linked-roles/discord/callback?code=x&state=${discord.state}`, discord.cookie))).status).toBe(400);
    // Only the one successful exchange reached Discord.
    expect(h.providers.callsTo("POST", "discord.com/api/v10/oauth2/token")).toHaveLength(1);
  });

  it("refuses an expired session", async () => {
    const h = await harness();
    const s = await startFlow(h);
    h.clock.advance(601);
    const response = await h.call(get(`/linked-roles/discord/callback?code=dcode&state=${s.state}`, s.cookie));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Link expired");
    expect(h.providers.calls).toHaveLength(0);
  });

  it("refuses a GitHub callback with the Discord-step cookie or a wrong state", async () => {
    const h = await harness();
    const s = await startFlow(h);
    expect((await h.call(get(`/linked-roles/github/callback?code=g&state=${s.state}`, s.cookie))).status).toBe(400);
    const discord = await throughDiscord(h);
    expect((await h.call(get(`/linked-roles/github/callback?code=g&state=nope`, discord.cookie))).status).toBe(400);
    expect(h.providers.callsTo("POST", "github.com/login/oauth/access_token")).toHaveLength(0);
  });

  it("stops when the user cancels, without reflecting provider text", async () => {
    const h = await harness();
    const s = await startFlow(h);
    const response = await h.call(
      get(`/linked-roles/discord/callback?error=access_denied&error_description=%3Cscript%3E&state=${s.state}`, s.cookie),
    );
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("cancelled");
    expect(html).not.toContain("<script>");
    const discord = await throughDiscord(h);
    const gh = await h.call(get(`/linked-roles/github/callback?error=access_denied&state=${discord.state}`, discord.cookie));
    expect(gh.status).toBe(400);
    expect(h.providers.callsTo("POST", "github.com/login/oauth/access_token")).toHaveLength(0);
  });

  it("answers 400 when a provider rejects the code or a scope is missing", async () => {
    quiet();
    const h = await harness();
    const s = await startFlow(h);
    const bad = await h.call(get(`/linked-roles/discord/callback?code=unknown&state=${s.state}`, s.cookie));
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("Discord authorization failed");

    const s2 = await startFlow(h);
    h.providers.discordCodes.set("narrow", { id: DISCORD_ID, scope: "identify" });
    expect((await h.call(get(`/linked-roles/discord/callback?code=narrow&state=${s2.state}`, s2.cookie))).status).toBe(400);
    expect(h.d1.row(DISCORD_ID)).toBeUndefined();

    const s3 = await startFlow(h);
    h.providers.discordCodes.set("norefresh", { id: DISCORD_ID, noRefresh: true });
    expect((await h.call(get(`/linked-roles/discord/callback?code=norefresh&state=${s3.state}`, s3.cookie))).status).toBe(400);
    expect(h.d1.row(DISCORD_ID)).toBeUndefined();

    const discord = await throughDiscord(h);
    const gh = await h.call(get(`/linked-roles/github/callback?code=unknown&state=${discord.state}`, discord.cookie));
    expect(gh.status).toBe(400);
    expect(await gh.text()).toContain("GitHub authorization failed");
    expect(h.d1.row(DISCORD_ID)?.github_login).toBeNull();
  });

  it("links but answers 502 and queues a retry when GitHub data cannot be read", async () => {
    const error = quiet();
    const h = await harness();
    h.providers.fail.add(`GET api.github.com/orgs/${ORG}/installation`);
    const response = await link(h, DISCORD_ID, "alice");
    expect(response.status).toBe(502);
    expect(await response.text()).toContain("alice");
    expect(h.d1.row(DISCORD_ID)).toMatchObject({ github_login: "alice", updated_at: 0 });
    expect(h.providers.roleConnections.size).toBe(0);
    expect(String(error.mock.calls[0]?.[1])).toContain("500");
  });

  it("does not answer other methods", async () => {
    const h = await harness();
    expect((await h.call(new Request(`${BASE}/linked-roles`, { method: "POST" }))).status).toBe(405);
  });
});

describe("escapeHtml", () => {
  it("escapes markup characters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&#60;a href=&#34;x&#34;&#62;&#39;&#38;&#39;&#60;/a&#62;");
  });
});
