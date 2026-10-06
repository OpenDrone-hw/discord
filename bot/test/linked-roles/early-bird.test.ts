import { describe, expect, it, vi } from "vitest";
import { Directory, DirectoryCache } from "../../src/config.ts";
import { DiscordClient } from "../../src/discord.ts";
import { GitHubApp } from "../../src/github.ts";
import { createWorker } from "../../src/index.ts";
import { signClaimToken, verifyClaimToken } from "../../src/linked-roles/early-bird.ts";
import { createLinkedRolesModule } from "../../src/linked-roles/index.ts";
import type { ServicesFactory } from "../../src/registry.ts";
import { fakeContext, makeEnv } from "../helpers.ts";
import { BASE, Clock, cookieFrom, fakeD1, FakeProviders, get } from "./harness.ts";

const KEY = "early-bird-test-key";
const GUILD = "1494019459822653512";
const ROLE = "777";
const CHANNEL = "888";
const ORDER = { orderId: "gid://shopify/Order/13395853017433", orderName: "#1297" };

/** Linked-roles worker whose bot client plays the guild: roles, channels, members. */
function setup(envOverrides: Record<string, unknown> = { EARLY_BIRD_CLAIM_KEY: KEY }, withRole = true) {
  const d1 = fakeD1();
  const providers = new FakeProviders();
  const clock = new Clock();
  const members = new Map<string, Set<string>>();
  const botCalls: { method: string; path: string; body: unknown }[] = [];
  const botFetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const path = url.pathname.replace("/api/v10", "");
    botCalls.push({ method, path, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    if (method === "GET" && path === `/guilds/${GUILD}/roles`) return json(withRole ? [{ id: ROLE, name: "Early Bird", position: 1 }] : []);
    if (method === "GET" && path === `/guilds/${GUILD}/channels`) return json([{ id: CHANNEL, name: "early-birds", type: 0 }]);
    const member = new RegExp(`^/guilds/${GUILD}/members/(\\d+)$`).exec(path);
    if (method === "PUT" && member) {
      const id = member[1]!;
      if (members.has(id)) return new Response(null, { status: 204 });
      members.set(id, new Set((body as { roles: string[] }).roles));
      return json({ user: { id } }, 201);
    }
    const role = new RegExp(`^/guilds/${GUILD}/members/(\\d+)/roles/(\\d+)$`).exec(path);
    if (method === "PUT" && role) {
      members.get(role[1]!)?.add(role[2]!);
      return new Response(null, { status: 204 });
    }
    return json({ message: `unexpected ${method} ${path}` }, 599);
  };
  const env = makeEnv({ DB: d1.db, SESSION_SECRET: "test-session-secret", ...envOverrides });
  const makeServices: ServicesFactory = (e, waitUntil) => {
    const discord = new DiscordClient({ token: e.DISCORD_BOT_TOKEN, fetch: botFetch });
    const github = new GitHubApp({ appId: e.GITHUB_APP_ID, privateKey: "", fetch: providers.fetch });
    return { env: e, waitUntil, discord, github, directory: new Directory(discord, e.GUILD_ID, { cache: new DirectoryCache() }) };
  };
  const worker = createWorker({
    modules: [createLinkedRolesModule({ fetch: providers.fetch, now: clock.now })],
    services: makeServices,
  });
  const context = fakeContext();
  const call = (request: Request) => worker.fetch!(request as Request<unknown, IncomingRequestCfProperties>, env, context.ctx);
  return { d1, providers, clock, members, botCalls, call };
}

type Setup = ReturnType<typeof setup>;

/** Runs the claim for one Discord user and returns the final response. */
async function claim(s: Setup, discordId: string, order = ORDER, code = `code-${discordId}`) {
  const token = await signClaimToken(KEY, order, s.clock.seconds + 600);
  const start = await s.call(get(`/early-bird?t=${token}`));
  expect(start.status).toBe(302);
  const location = new URL(start.headers.get("Location") ?? "");
  s.providers.discordCodes.set(code, { id: discordId, scope: "identify guilds.join" });
  return s.call(get(`/linked-roles/discord/callback?code=${code}&state=${location.searchParams.get("state")}`, cookieFrom(start)));
}

describe("claim token", () => {
  it("round-trips and rejects an altered, foreign or expired token", async () => {
    const token = await signClaimToken(KEY, ORDER, 2000);
    expect(await verifyClaimToken(KEY, token, 1000)).toEqual(ORDER);
    expect(await verifyClaimToken(KEY, token, 2000)).toBeNull();
    expect(await verifyClaimToken("other-key", token, 1000)).toBeNull();
    const [v, body, mac] = token.split(".");
    const forged = `${v}.${btoa(JSON.stringify({ o: "gid://shopify/Order/1", n: "#1", exp: 2000 })).replace(/=+$/, "")}.${mac}`;
    expect(await verifyClaimToken(KEY, forged, 1000)).toBeNull();
    expect(await verifyClaimToken(KEY, `${v}.${body}`, 1000)).toBeNull();
  });

  it("refuses an order id that is not a Shopify order GID", async () => {
    const token = await signClaimToken(KEY, { orderId: "gid://shopify/Customer/1", orderName: "#1" }, 2000);
    expect(await verifyClaimToken(KEY, token, 1000)).toBeNull();
  });
});

describe("GET /early-bird", () => {
  it("redirects to Discord with identify and guilds.join on the registered callback", async () => {
    const s = setup();
    const token = await signClaimToken(KEY, ORDER, s.clock.seconds + 600);
    const response = await s.call(get(`/early-bird?t=${token}`));
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.searchParams.get("scope")).toBe("identify guilds.join");
    expect(location.searchParams.get("redirect_uri")).toBe(`${BASE}/linked-roles/discord/callback`);
    expect(response.headers.get("Set-Cookie")).toContain("HttpOnly");
  });

  it("refuses a bad token and is closed without the key", async () => {
    expect((await setup().call(get("/early-bird?t=v1.x.y"))).status).toBe(400);
    expect((await setup({}).call(get("/early-bird?t=v1.x.y"))).status).toBe(503);
  });
});

describe("claim", () => {
  it("adds a new member to the server with the role and records the order", async () => {
    const s = setup();
    const response = await claim(s, "111111111111111111");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("#1297");
    expect(html).toContain(`https://discord.com/channels/${GUILD}/${CHANNEL}`);
    expect(s.members.get("111111111111111111")).toEqual(new Set([ROLE]));
    const join = s.botCalls.find((c) => c.method === "PUT" && c.path.endsWith("/members/111111111111111111"))!;
    expect((join.body as { roles: string[] }).roles).toEqual([ROLE]);
    expect(s.d1.sqlite.prepare("SELECT order_id, order_name, discord_id FROM early_bird_claims").all()).toEqual([
      { order_id: ORDER.orderId, order_name: "#1297", discord_id: "111111111111111111" },
    ]);
  });

  it("adds the role to an existing member", async () => {
    const s = setup();
    s.members.set("222222222222222222", new Set());
    expect((await claim(s, "222222222222222222")).status).toBe(200);
    expect(s.members.get("222222222222222222")).toEqual(new Set([ROLE]));
  });

  it("lets one Discord account claim an order once, and the same account again", async () => {
    const s = setup();
    expect((await claim(s, "111111111111111111")).status).toBe(200);
    const second = await claim(s, "333333333333333333", ORDER, "code-b");
    expect(second.status).toBe(409);
    expect(s.members.has("333333333333333333")).toBe(false);
    expect((await claim(s, "111111111111111111", ORDER, "code-again")).status).toBe(200);
    const other = { orderId: "gid://shopify/Order/42", orderName: "#1042" };
    expect((await claim(s, "333333333333333333", other, "code-c")).status).toBe(200);
  });

  it("claims nothing when the role is missing", async () => {
    const s = setup(undefined, false);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await claim(s, "111111111111111111")).status).toBe(503);
    expect(s.members.size).toBe(0);
    expect(s.d1.sqlite.prepare("SELECT COUNT(*) AS n FROM early_bird_claims").get()).toEqual({ n: 0 });
  });

  it("refuses a callback whose state does not match", async () => {
    const s = setup();
    const token = await signClaimToken(KEY, ORDER, s.clock.seconds + 600);
    const start = await s.call(get(`/early-bird?t=${token}`));
    const response = await s.call(get(`/linked-roles/discord/callback?code=x&state=wrong`, cookieFrom(start)));
    expect(response.status).toBe(400);
    expect(s.members.size).toBe(0);
  });
});
