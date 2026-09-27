import { describe, expect, it, vi } from "vitest";
import { DirectoryCache, Directory } from "../src/config.ts";
import { DiscordClient } from "../src/discord.ts";
import type { Env } from "../src/env.ts";
import { GitHubApp } from "../src/github.ts";
import { createWorker, modules } from "../src/index.ts";
import { ERROR_TEXT, UNKNOWN_TEXT, WRONG_GUILD_TEXT, defer, ephemeral, messageResponse } from "../src/interactions.ts";
import { MODULE_ROUTES, Registry, RegistryError, type BotModule, type ServicesFactory } from "../src/registry.ts";
import type { Services } from "../src/services.ts";
import { InteractionResponseType, type InteractionResponse } from "../src/types.ts";
import {
  ed25519Signer,
  fakeContext,
  githubSignature,
  jsonResponse,
  makeEnv,
  mockFetch,
  nowSeconds,
  type Ed25519Signer,
} from "./helpers.ts";

const BASE = "https://bot.example.workers.dev";
const GUILD = "1494019459822653512";
const APP = "1553748824470851644";

function servicesWith(fetch: ReturnType<typeof mockFetch>["fetch"]): ServicesFactory {
  return (env: Env, waitUntil) => {
    const discord = new DiscordClient({ token: env.DISCORD_BOT_TOKEN, fetch });
    return {
      env,
      waitUntil,
      discord,
      get github(): GitHubApp {
        throw new Error("not used");
      },
      directory: new Directory(discord, env.GUILD_ID, { cache: new DirectoryCache() }),
    } satisfies Services;
  };
}

async function signedInteraction(signer: Ed25519Signer, body: unknown, timestamp = nowSeconds()): Promise<Request> {
  const text = JSON.stringify(body);
  return new Request(`${BASE}/interactions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Signature-Ed25519": await signer.sign(timestamp, text),
      "X-Signature-Timestamp": timestamp,
    },
    body: text,
  });
}

async function githubDelivery(secret: string, event: string, payload: unknown): Promise<Request> {
  const text = JSON.stringify(payload);
  return new Request(`${BASE}/github`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": event,
      "X-GitHub-Delivery": "d-1",
      "X-Hub-Signature-256": await githubSignature(secret, text),
    },
    body: text,
  });
}

function command(name: string, overrides: Partial<Interaction> = {}) {
  return {
    id: "1600000000000000001",
    application_id: APP,
    type: 2,
    token: "interaction-token",
    guild_id: GUILD,
    data: { id: "1", name, type: 1 },
    ...overrides,
  };
}
type Interaction = Record<string, unknown>;

async function setup(testModules: BotModule[] = []) {
  const signer = await ed25519Signer();
  const env = makeEnv({ DISCORD_PUBLIC_KEY: signer.publicKeyHex });
  const discord = mockFetch(() => jsonResponse({ id: "m1" }));
  const worker = createWorker({ modules: testModules, services: servicesWith(discord.fetch) });
  const context = fakeContext();
  const call = (request: Request) => worker.fetch!(request as Request<unknown, IncomingRequestCfProperties>, env, context.ctx);
  return { signer, env, discord, worker, context, call };
}

describe("routing", () => {
  it("returns 404 for unknown paths and 405 for wrong methods", async () => {
    const { call } = await setup([...modules]);
    expect((await call(new Request(`${BASE}/`))).status).toBe(404);
    expect((await call(new Request(`${BASE}/nope`, { method: "POST" }))).status).toBe(404);
    const getInteractions = await call(new Request(`${BASE}/interactions`));
    expect(getInteractions.status).toBe(405);
    expect(getInteractions.headers.get("Allow")).toBe("POST");
    expect((await call(new Request(`${BASE}/github`))).status).toBe(405);
    expect((await call(new Request(`${BASE}/linked-roles`, { method: "POST" }))).status).toBe(405);
  });

  it("serves the linked-role routes", async () => {
    const { call } = await setup([...modules]);
    const start = await call(new Request(`${BASE}/linked-roles`));
    expect(start.status).toBe(302);
    expect(start.headers.get("Location")).toMatch(/^https:\/\/discord\.com\/oauth2\/authorize\?/);
    // Callbacks without the session cookie are refused before any provider call.
    for (const route of MODULE_ROUTES.slice(1)) {
      const path = route.split(" ")[1];
      expect((await call(new Request(`${BASE}${path}?code=x&state=y`))).status).toBe(400);
    }
  });

  it("dispatches module routes and hides handler errors behind a 500", async () => {
    const { call } = await setup([
      {
        name: "t",
        routes: [
          { route: "GET /linked-roles", handle: () => new Response("hello") },
          {
            route: "GET /linked-roles/github/callback",
            handle: () => {
              throw new Error("secret detail");
            },
          },
        ],
      },
    ]);
    expect(await (await call(new Request(`${BASE}/linked-roles?x=1`))).text()).toBe("hello");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = await call(new Request(`${BASE}/linked-roles/github/callback`));
    expect(failed.status).toBe(500);
    expect(await failed.text()).toBe("internal error");
    expect(error).toHaveBeenCalled();
    expect((await call(new Request(`${BASE}/linked-roles/discord/callback`))).status).toBe(404);
  });
});

describe("POST /interactions", () => {
  it("answers 401 without a valid signature", async () => {
    const { call, signer } = await setup();
    const body = JSON.stringify({ type: 1 });
    expect((await call(new Request(`${BASE}/interactions`, { method: "POST", body }))).status).toBe(401);

    const other = await ed25519Signer();
    expect((await call(await signedInteraction(other, { type: 1 }))).status).toBe(401);

    const tampered = await signedInteraction(signer, { type: 1 });
    const headers = new Headers(tampered.headers);
    expect(
      (await call(new Request(`${BASE}/interactions`, { method: "POST", headers, body: JSON.stringify({ type: 2 }) }))).status,
    ).toBe(401);

    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    expect((await call(await signedInteraction(signer, { type: 1 }, stale))).status).toBe(401);
  });

  it("answers PING with PONG", async () => {
    const { call, signer } = await setup();
    const response = await call(await signedInteraction(signer, { type: 1, id: "1", application_id: APP, token: "t" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(await response.json()).toEqual({ type: 1 });
  });

  it("routes a slash command to its module and suppresses mentions", async () => {
    const execute = vi.fn((): InteractionResponse => ({ type: 4, data: { content: "hi @everyone" } }));
    const { call, signer } = await setup([{ name: "t", commands: [{ definition: { name: "hello", description: "x" }, execute }] }]);
    const response = await call(await signedInteraction(signer, command("hello")));
    expect(await response.json()).toEqual({
      type: 4,
      data: { content: "hi @everyone", allowed_mentions: { parse: [] } },
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]).toBeDefined();
  });

  it("routes message context-menu commands by type", async () => {
    const slash = vi.fn(() => ephemeral("slash"));
    const menu = vi.fn(() => ephemeral("menu"));
    const { call, signer } = await setup([
      {
        name: "t",
        commands: [
          { definition: { name: "Approve build", description: "x" }, execute: slash },
          { definition: { name: "Approve build", type: 3 }, execute: menu },
        ],
      },
    ]);
    const response = await call(
      await signedInteraction(signer, command("Approve build", { data: { name: "Approve build", type: 3, target_id: "5" } })),
    );
    expect(((await response.json()) as { data: { content: string } }).data.content).toBe("menu");
    expect(slash).not.toHaveBeenCalled();
  });

  it("answers unknown commands and components ephemerally", async () => {
    const { call, signer } = await setup();
    const unknown = (await (await call(await signedInteraction(signer, command("nope")))).json()) as InteractionResponse;
    expect(unknown).toEqual({ type: 4, data: { content: UNKNOWN_TEXT, flags: 64, allowed_mentions: { parse: [] } } });
    const button = await call(
      await signedInteraction(signer, command("", { type: 3, data: { custom_id: "missing:1", component_type: 2 } })),
    );
    expect(((await button.json()) as { data: { content: string } }).data.content).toBe(UNKNOWN_TEXT);
  });

  it("refuses interactions from another guild or a DM", async () => {
    const execute = vi.fn(() => ephemeral("x"));
    const { call, signer } = await setup([{ name: "t", commands: [{ definition: { name: "hello" }, execute }] }]);
    for (const guild of ["999999999999999999", undefined]) {
      const response = await call(await signedInteraction(signer, command("hello", { guild_id: guild })));
      expect(((await response.json()) as { data: { content: string } }).data.content).toBe(WRONG_GUILD_TEXT);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("turns a handler error into an ephemeral message", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { call, signer } = await setup([
      {
        name: "t",
        commands: [
          {
            definition: { name: "boom" },
            execute: () => {
              throw new Error("kaput");
            },
          },
        ],
      },
    ]);
    const response = (await (await call(await signedInteraction(signer, command("boom")))).json()) as {
      data: { content: string; flags: number };
    };
    expect(response.data).toEqual({ content: ERROR_TEXT, flags: 64, allowed_mentions: { parse: [] } });
    expect(String(error.mock.calls[0]?.[1])).toContain("kaput");
  });

  it("serves autocomplete, capped at 25 choices", async () => {
    const choices = Array.from({ length: 30 }, (_, i) => ({ name: `repo-${i}`, value: `repo-${i}` }));
    const { call, signer } = await setup([
      {
        name: "t",
        commands: [{ definition: { name: "editing" }, execute: () => ephemeral("x"), autocomplete: () => choices }],
      },
    ]);
    const response = (await (
      await call(await signedInteraction(signer, command("editing", { type: 4 })))
    ).json()) as { type: number; data: { choices: unknown[] } };
    expect(response.type).toBe(InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT);
    expect(response.data.choices).toHaveLength(25);
  });

  it("routes components and modals by custom_id prefix", async () => {
    const handle = vi.fn(() => ({ type: 7, data: { content: "updated" } }));
    const { call, signer } = await setup([{ name: "t", components: [{ prefix: "verify", handle }] }]);
    for (const type of [3, 5]) {
      const response = (await (
        await call(await signedInteraction(signer, command("", { type, data: { custom_id: "verify:123" } })))
      ).json()) as InteractionResponse;
      expect(response).toEqual({ type: 7, data: { content: "updated", allowed_mentions: { parse: [] } } });
    }
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it("defers and edits the original response in the background", async () => {
    const { call, signer, discord, context } = await setup([
      {
        name: "t",
        commands: [
          {
            definition: { name: "slow" },
            execute: (ctx) => defer(ctx, async () => "done <@123>", { ephemeral: true }),
          },
        ],
      },
    ]);
    const response = (await (await call(await signedInteraction(signer, command("slow")))).json()) as InteractionResponse;
    expect(response).toEqual({ type: 5, data: { flags: 64 } });
    await context.settle();
    expect(discord.calls).toHaveLength(1);
    expect(discord.calls[0]?.method).toBe("PATCH");
    expect(discord.calls[0]?.url).toBe(`https://discord.com/api/v10/webhooks/${APP}/interaction-token/messages/@original`);
    expect(discord.calls[0]?.body).toEqual({ content: "done <@123>", allowed_mentions: { parse: [] } });
    expect(discord.calls[0]?.headers.authorization).toBeUndefined();
  });

  it("replaces a failed deferred result with the error text", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { call, signer, discord, context } = await setup([
      {
        name: "t",
        commands: [
          {
            definition: { name: "slow" },
            execute: (ctx) =>
              defer(ctx, async () => {
                throw new Error("nope");
              }),
          },
        ],
      },
    ]);
    await call(await signedInteraction(signer, command("slow")));
    await context.settle();
    expect(discord.calls[0]?.body).toEqual({ content: ERROR_TEXT, allowed_mentions: { parse: [] } });
  });
});

describe("POST /github", () => {
  it("answers 401 without a valid signature", async () => {
    const { call, env } = await setup();
    const unsigned = new Request(`${BASE}/github`, {
      method: "POST",
      headers: { "X-GitHub-Event": "ping" },
      body: "{}",
    });
    expect((await call(unsigned)).status).toBe(401);
    const wrong = await githubDelivery("other-secret", "ping", {});
    expect((await call(wrong)).status).toBe(401);
    expect(env.GITHUB_WEBHOOK_SECRET).toBe("webhook-secret");
  });

  it("answers ping", async () => {
    const { call, env } = await setup();
    const response = await call(await githubDelivery(env.GITHUB_WEBHOOK_SECRET, "ping", { zen: "Keep it logically awesome." }));
    expect(response.status).toBe(200);
  });

  it("dispatches by event and action in waitUntil after a 202", async () => {
    const seen: string[] = [];
    const { call, env, context } = await setup([
      {
        name: "t",
        github: [
          {
            event: "pull_request",
            actions: ["opened", "synchronize"],
            handle: async ({ action, delivery, payload }) => {
              seen.push(`pr:${action}:${delivery}:${(payload.number as number) ?? ""}`);
            },
          },
          { event: "pull_request", handle: async ({ action }) => void seen.push(`any:${action}`) },
          { event: "release", handle: async () => void seen.push("release") },
        ],
      },
    ]);
    const opened = await call(await githubDelivery(env.GITHUB_WEBHOOK_SECRET, "pull_request", { action: "opened", number: 7 }));
    expect(opened.status).toBe(202);
    expect(await opened.json()).toEqual({ ok: true, handlers: 2 });
    await context.settle();
    expect(seen.sort()).toEqual(["any:opened", "pr:opened:d-1:7"]);

    seen.length = 0;
    await call(await githubDelivery(env.GITHUB_WEBHOOK_SECRET, "pull_request", { action: "closed" }));
    await context.settle();
    expect(seen).toEqual(["any:closed"]);
  });

  it("logs a failing handler without affecting the others", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ran: string[] = [];
    const { call, env, context } = await setup([
      {
        name: "t",
        github: [
          {
            event: "push",
            handle: async () => {
              throw new Error("broken handler");
            },
          },
          { event: "push", handle: async () => void ran.push("second") },
        ],
      },
    ]);
    expect((await call(await githubDelivery(env.GITHUB_WEBHOOK_SECRET, "push", { ref: "refs/heads/main" }))).status).toBe(202);
    await context.settle();
    expect(ran).toEqual(["second"]);
    expect(String(error.mock.calls[0]?.[1])).toContain("broken handler");
  });

  it("rejects a missing event header and invalid JSON", async () => {
    const { call, env } = await setup();
    const body = "{not json";
    const headers = {
      "X-GitHub-Event": "push",
      "X-Hub-Signature-256": await githubSignature(env.GITHUB_WEBHOOK_SECRET, body),
    };
    expect((await call(new Request(`${BASE}/github`, { method: "POST", headers, body }))).status).toBe(400);
    const noEvent = await githubDelivery(env.GITHUB_WEBHOOK_SECRET, "push", {});
    const stripped = new Headers(noEvent.headers);
    stripped.delete("X-GitHub-Event");
    expect(
      (await call(new Request(`${BASE}/github`, { method: "POST", headers: stripped, body: "{}" }))).status,
    ).toBe(400);
  });
});

describe("scheduled", () => {
  it("runs every module's scheduled handler in waitUntil", async () => {
    const ran: string[] = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { worker, env, context } = await setup([
      { name: "a", scheduled: async () => void ran.push("a") },
      {
        name: "b",
        scheduled: async () => {
          throw new Error("b failed");
        },
      },
      { name: "c" },
    ]);
    await worker.scheduled!({ cron: "17 */6 * * *", scheduledTime: 0, noRetry() {} } as ScheduledController, env, context.ctx);
    await context.settle();
    expect(ran).toEqual(["a"]);
    expect(context.pending).toHaveLength(2);
  });
});

describe("Registry", () => {
  it("accepts the shipped modules", () => {
    const registry = new Registry(modules);
    expect(registry.modules.map((m) => m.name)).toEqual(["github", "commands", "linked-roles"]);
    expect(registry.commandDefinitions().map((c) => c.name)).toEqual([
      "link",
      "branch",
      "editing",
      "verify",
      "promote",
      "To GitHub issue",
      "Approve build",
    ]);
    expect(registry.roleConnectionMetadata().map((m) => m.key)).toEqual(["merged_prs", "org_member", "maintainer", "owner"]);
  });

  it("rejects duplicate modules, commands, prefixes, routes and metadata keys", () => {
    const cmd = { definition: { name: "x" }, execute: () => ephemeral("x") };
    expect(() => new Registry([{ name: "a" }, { name: "a" }])).toThrow(RegistryError);
    expect(() => new Registry([{ name: "a", commands: [cmd] }, { name: "b", commands: [cmd] }])).toThrow(/command x/);
    const comp = { prefix: "p", handle: () => ephemeral("x") };
    expect(() => new Registry([{ name: "a", components: [comp, comp] }])).toThrow(/prefix p/);
    expect(() => new Registry([{ name: "a", components: [{ prefix: "Bad:Prefix", handle: comp.handle }] }])).toThrow(
      /must match/,
    );
    const route = { route: "GET /linked-roles" as const, handle: () => new Response() };
    expect(() => new Registry([{ name: "a", routes: [route] }, { name: "b", routes: [route] }])).toThrow(/route/);
    const meta = { type: 7, key: "k", name: "n", description: "d" };
    expect(() => new Registry([{ name: "a", roleConnectionMetadata: [meta, meta] }])).toThrow(/metadata key/);
  });

  it("rejects routes outside MODULE_ROUTES", () => {
    const routes = [{ route: "POST /interactions", handle: () => new Response() }] as unknown as BotModule["routes"];
    expect(() => new Registry([{ name: "a", routes: routes! }])).toThrow(/not in MODULE_ROUTES/);
  });

  it("enforces Discord's command and metadata limits", () => {
    const menus = Array.from({ length: 6 }, (_, i) => ({ definition: { name: `m${i}`, type: 3 }, execute: () => ephemeral("x") }));
    expect(() => new Registry([{ name: "a", commands: menus }])).toThrow(/message commands/);
    const meta = Array.from({ length: 6 }, (_, i) => ({ type: 7, key: `k${i}`, name: "n", description: "d" }));
    expect(() => new Registry([{ name: "a", roleConnectionMetadata: meta }])).toThrow(/metadata records/);
  });
});

describe("response helpers", () => {
  it("builds ephemeral and public messages with mentions suppressed", () => {
    expect(messageResponse("hi")).toEqual({ type: 4, data: { content: "hi", allowed_mentions: { parse: [] } } });
    expect(messageResponse({ content: "x", flags: 4 }, { ephemeral: true })).toEqual({
      type: 4,
      data: { content: "x", flags: 68, allowed_mentions: { parse: [] } },
    });
    expect(messageResponse({ content: "<@&1>", allowed_mentions: { roles: ["1"] } }).data).toEqual({
      content: "<@&1>",
      allowed_mentions: { roles: ["1"] },
    });
  });
});
