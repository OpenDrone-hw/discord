import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUDIT_REASON,
  DiscordClient,
  DiscordError,
  RateLimitError,
  redactPath,
  routeKey,
  suppressMentions,
} from "../src/discord.ts";
import { BOT_TOKEN, jsonResponse, mockFetch } from "./helpers.ts";

const CHANNEL = "1494779609131258048";
const MESSAGE = "1500000000000000001";
const GUILD = "1494019459822653512";
const APP = "1553748824470851644";
const INTERACTION_TOKEN = "aW50ZXJhY3Rpb24tdG9rZW4tc2VjcmV0";

function clock(start = 1_000_000) {
  let now = start;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("routeKey and redactPath", () => {
  it("keeps major parameters and generalises other ids", () => {
    expect(routeKey("post", `/channels/${CHANNEL}/messages`)).toBe(`POST /channels/${CHANNEL}/messages`);
    expect(routeKey("PATCH", `/channels/${CHANNEL}/messages/${MESSAGE}`)).toBe(`PATCH /channels/${CHANNEL}/messages/:id`);
    expect(routeKey("PUT", `/guilds/${GUILD}/members/${MESSAGE}/roles/${CHANNEL}`)).toBe(
      `PUT /guilds/${GUILD}/members/:id/roles/:id`,
    );
    expect(routeKey("POST", `/webhooks/${APP}/${INTERACTION_TOKEN}`)).toBe(`POST /webhooks/${APP}/:token`);
    expect(routeKey("PUT", `/channels/${CHANNEL}/messages/${MESSAGE}/reactions/%F0%9F%91%8D/@me`)).toBe(
      `PUT /channels/${CHANNEL}/messages/:id/reactions/:emoji/@me`,
    );
  });

  it("redacts tokens in webhook and interaction paths", () => {
    expect(redactPath(`/webhooks/${APP}/${INTERACTION_TOKEN}/messages/@original`)).toBe(
      `/webhooks/${APP}/:token/messages/@original`,
    );
    expect(redactPath(`/interactions/${MESSAGE}/${INTERACTION_TOKEN}/callback`)).toBe(
      `/interactions/${MESSAGE}/:token/callback`,
    );
    expect(redactPath(`/channels/${CHANNEL}`)).toBe(`/channels/${CHANNEL}`);
  });
});

describe("suppressMentions", () => {
  it("adds allowed_mentions to message bodies", () => {
    expect(suppressMentions("POST", `/channels/${CHANNEL}/messages`, { content: "@everyone" })).toEqual({
      content: "@everyone",
      allowed_mentions: { parse: [] },
    });
    expect(suppressMentions("PATCH", `/webhooks/${APP}/${INTERACTION_TOKEN}/messages/@original`, { content: "x" })).toEqual({
      content: "x",
      allowed_mentions: { parse: [] },
    });
    expect(suppressMentions("POST", `/webhooks/${APP}/${INTERACTION_TOKEN}`, { content: "x" })).toEqual({
      content: "x",
      allowed_mentions: { parse: [] },
    });
  });

  it("nests into forum posts and interaction callbacks", () => {
    expect(suppressMentions("POST", `/channels/${CHANNEL}/threads`, { name: "t", message: { content: "<@1>" } })).toEqual({
      name: "t",
      message: { content: "<@1>", allowed_mentions: { parse: [] } },
    });
    expect(
      suppressMentions("POST", `/interactions/${MESSAGE}/${INTERACTION_TOKEN}/callback`, { type: 4, data: { content: "x" } }),
    ).toEqual({ type: 4, data: { content: "x", allowed_mentions: { parse: [] } } });
    const deferred = { type: 5, data: { flags: 64 } };
    expect(suppressMentions("POST", `/interactions/${MESSAGE}/${INTERACTION_TOKEN}/callback`, deferred)).toBe(deferred);
  });

  it("keeps an explicit allowed_mentions and leaves other routes alone", () => {
    const ping = { content: "<@&42>", allowed_mentions: { roles: ["42"] } };
    expect(suppressMentions("POST", `/channels/${CHANNEL}/messages`, ping)).toBe(ping);
    const bulk = { messages: ["1", "2"] };
    expect(suppressMentions("POST", `/channels/${CHANNEL}/messages/bulk-delete`, bulk)).toBe(bulk);
    const patch = { name: "renamed" };
    expect(suppressMentions("PATCH", `/channels/${CHANNEL}`, patch)).toBe(patch);
    expect(suppressMentions("GET", `/channels/${CHANNEL}/messages`, patch)).toBe(patch);
  });
});

describe("DiscordClient requests", () => {
  it("sends bot auth, user agent, JSON and an encoded audit reason", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ id: MESSAGE }));
    const client = new DiscordClient({ token: BOT_TOKEN, fetch });
    await client.sendMessage(CHANNEL, { content: "hello @everyone" });
    await client.addMemberRole(GUILD, MESSAGE, CHANNEL, "Approve build: OpenRX");
    await client.getGuildRoles(GUILD);

    const [send, role, read] = calls;
    expect(send?.url).toBe(`https://discord.com/api/v10/channels/${CHANNEL}/messages`);
    expect(send?.method).toBe("POST");
    expect(send?.headers.authorization).toBe(`Bot ${BOT_TOKEN}`);
    expect(send?.headers["user-agent"]).toMatch(/^DiscordBot \(/);
    expect(send?.headers["content-type"]).toBe("application/json");
    expect(send?.headers["x-audit-log-reason"]).toBe(encodeURIComponent(DEFAULT_AUDIT_REASON));
    expect(send?.body).toEqual({ content: "hello @everyone", allowed_mentions: { parse: [] } });
    expect(role?.method).toBe("PUT");
    expect(role?.headers["x-audit-log-reason"]).toBe("Approve%20build%3A%20OpenRX");
    expect(read?.headers["x-audit-log-reason"]).toBeUndefined();
    expect(read?.body).toBeUndefined();
  });

  it("suppresses mentions in forum posts, follow-ups and edits", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ id: MESSAGE }));
    const client = new DiscordClient({ token: BOT_TOKEN, fetch });
    await client.createForumPost(CHANNEL, { name: "OpenRX #12", message: { content: "by @someone" }, applied_tags: ["1"] });
    await client.followUp(APP, INTERACTION_TOKEN, { content: "<@123>" });
    await client.editOriginalResponse(APP, INTERACTION_TOKEN, { content: "<@&456>" });
    await client.editMessage(CHANNEL, MESSAGE, { content: "@here" });
    await client.executeWebhook(APP, INTERACTION_TOKEN, { content: "@everyone", thread_name: "x" });
    await client.createInteractionResponse(MESSAGE, INTERACTION_TOKEN, { type: 4, data: { content: "@everyone" } });

    expect((calls[0]?.body as { message: unknown }).message).toEqual({
      content: "by @someone",
      allowed_mentions: { parse: [] },
    });
    for (const call of calls.slice(1, 5)) {
      expect((call.body as { allowed_mentions: unknown }).allowed_mentions).toEqual({ parse: [] });
    }
    expect((calls[5]?.body as { data: { allowed_mentions: unknown } }).data.allowed_mentions).toEqual({ parse: [] });
  });

  it("keeps an explicit role ping", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ id: MESSAGE }));
    const client = new DiscordClient({ token: BOT_TOKEN, fetch });
    await client.sendMessage(CHANNEL, { content: "<@&42> release", allowed_mentions: { roles: ["42"] } });
    expect((calls[0]?.body as { allowed_mentions: unknown }).allowed_mentions).toEqual({ roles: ["42"] });
  });

  it("does not send the bot token or an audit reason on token routes", async () => {
    const { fetch, calls } = mockFetch((_, i) => (i === 0 ? jsonResponse(null, 204) : jsonResponse({ id: "1" })));
    const client = new DiscordClient({ fetch });
    expect(await client.createInteractionResponse(MESSAGE, INTERACTION_TOKEN, { type: 5 })).toBeNull();
    await client.followUp(APP, INTERACTION_TOKEN, { content: "done" });
    for (const call of calls) {
      expect(call.headers.authorization).toBeUndefined();
      expect(call.headers["x-audit-log-reason"]).toBeUndefined();
    }
  });

  it("uses a bearer token when given", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const client = new DiscordClient({ token: BOT_TOKEN, fetch });
    await client.request("PUT", `/users/@me/applications/${APP}/role-connection`, {
      bearer: "user-access-token",
      body: { metadata: {} },
    });
    expect(calls[0]?.headers.authorization).toBe("Bearer user-access-token");
    expect(calls[0]?.headers["x-audit-log-reason"]).toBeUndefined();
  });

  it("refuses a bot route without a token", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({}));
    const client = new DiscordClient({ fetch });
    await expect(client.getChannel(CHANNEL)).rejects.toThrow(/needs a bot token/);
    expect(calls).toHaveLength(0);
  });

  it("adds query parameters", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse({ id: "1" }));
    const client = new DiscordClient({ fetch });
    await client.executeWebhook(APP, INTERACTION_TOKEN, { content: "x" }, { threadId: CHANNEL });
    expect(calls[0]?.url).toBe(`https://discord.com/api/v10/webhooks/${APP}/${INTERACTION_TOKEN}?wait=true&thread_id=${CHANNEL}`);
  });

  it("throws DiscordError with status and code, without the token", async () => {
    const { fetch } = mockFetch(() => jsonResponse({ code: 50013, message: "Missing Permissions" }, 403));
    const client = new DiscordClient({ token: BOT_TOKEN, fetch });
    const error = await client.sendMessage(CHANNEL, { content: "x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DiscordError);
    expect((error as DiscordError).status).toBe(403);
    expect((error as DiscordError).code).toBe(50013);
    expect((error as DiscordError).message).toContain("Missing Permissions");
    expect((error as DiscordError).message).not.toContain(BOT_TOKEN);
  });

  it("redacts the interaction token from errors", async () => {
    const { fetch } = mockFetch(() => jsonResponse({ code: 10015, message: "Unknown Webhook" }, 404));
    const client = new DiscordClient({ fetch });
    const error = (await client.followUp(APP, INTERACTION_TOKEN, { content: "x" }).catch((e: unknown) => e)) as Error;
    expect(error.message).toContain(`/webhooks/${APP}/:token`);
    expect(error.message).not.toContain(INTERACTION_TOKEN);
  });
});

describe("DiscordClient rate limits", () => {
  it("waits retry_after on 429 and retries", async () => {
    const time = clock();
    const { fetch, calls } = mockFetch((_, i) =>
      i === 0
        ? jsonResponse({ message: "You are being rate limited.", retry_after: 1.25, global: false }, 429)
        : jsonResponse({ id: MESSAGE }),
    );
    const client = new DiscordClient({ token: BOT_TOKEN, fetch, sleep: time.sleep, now: time.now });
    expect(await client.sendMessage(CHANNEL, { content: "x" })).toEqual({ id: MESSAGE });
    expect(time.sleeps).toEqual([1250]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toEqual(calls[0]?.body);
  });

  it("falls back to the Retry-After header", async () => {
    const time = clock();
    const { fetch } = mockFetch((_, i) =>
      i === 0 ? new Response("", { status: 429, headers: { "Retry-After": "2" } }) : jsonResponse({ id: "1" }),
    );
    const client = new DiscordClient({ token: BOT_TOKEN, fetch, sleep: time.sleep, now: time.now });
    await client.getChannel(CHANNEL);
    expect(time.sleeps).toEqual([2000]);
  });

  it("gives up after maxRetries", async () => {
    const time = clock();
    const { fetch, calls } = mockFetch(() => jsonResponse({ retry_after: 0.1, global: false }, 429));
    const client = new DiscordClient({ token: BOT_TOKEN, fetch, sleep: time.sleep, now: time.now, maxRetries: 2 });
    await expect(client.getChannel(CHANNEL)).rejects.toBeInstanceOf(RateLimitError);
    expect(calls).toHaveLength(3);
    expect(time.sleeps).toEqual([100, 100]);
  });

  it("throws instead of waiting longer than maxWaitMs", async () => {
    const time = clock();
    const { fetch, calls } = mockFetch(() => jsonResponse({ retry_after: 60, global: false }, 429));
    const client = new DiscordClient({ token: BOT_TOKEN, fetch, sleep: time.sleep, now: time.now, maxWaitMs: 5000 });
    const error = (await client.getChannel(CHANNEL).catch((e: unknown) => e)) as RateLimitError;
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.retryAfterMs).toBe(60_000);
    expect(calls).toHaveLength(1);
    expect(time.sleeps).toEqual([]);
  });

  it("waits for an exhausted bucket before the next request on that route", async () => {
    const time = clock();
    const { fetch, calls } = mockFetch(() =>
      jsonResponse({ id: MESSAGE }, 200, {
        "X-RateLimit-Bucket": "abcd",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset-After": "0.5",
      }),
    );
    const client = new DiscordClient({ token: BOT_TOKEN, fetch, sleep: time.sleep, now: time.now });
    await client.sendMessage(CHANNEL, { content: "1" });
    expect(time.sleeps).toEqual([]);
    await client.sendMessage(CHANNEL, { content: "2" });
    expect(time.sleeps).toEqual([500]);
    expect(calls).toHaveLength(2);
  });

  it("does not wait for another channel's bucket or an expired one", async () => {
    const time = clock();
    const { fetch } = mockFetch(() =>
      jsonResponse({ id: MESSAGE }, 200, {
        "X-RateLimit-Bucket": "abcd",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset-After": "0.5",
      }),
    );
    const client = new DiscordClient({ token: BOT_TOKEN, fetch, sleep: time.sleep, now: time.now });
    await client.sendMessage(CHANNEL, { content: "1" });
    await client.sendMessage("1494782854117326969", { content: "other channel" });
    expect(time.sleeps).toEqual([]);
    time.advance(600);
    await client.sendMessage(CHANNEL, { content: "after reset" });
    expect(time.sleeps).toEqual([]);
  });

  it("applies a global 429 to every route", async () => {
    const time = clock();
    const { fetch } = mockFetch((_, i) =>
      i === 0 ? jsonResponse({ retry_after: 0.3, global: true }, 429) : jsonResponse({ id: "1" }),
    );
    // maxRetries 0: the first request fails, but the global limit still applies to the next one.
    const client = new DiscordClient({ token: BOT_TOKEN, fetch, sleep: time.sleep, now: time.now, maxRetries: 0 });
    await expect(client.getChannel(CHANNEL)).rejects.toBeInstanceOf(RateLimitError);
    await client.getGuildRoles(GUILD);
    expect(time.sleeps).toEqual([300]);
  });
});
