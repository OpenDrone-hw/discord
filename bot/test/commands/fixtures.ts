/**
 * Offline fixtures for the commands module: a fake guild (product channels,
 * the retired forum, roles), a routed fetch mock shared by the Discord and GitHub clients, and
 * interaction builders.
 */
import { Directory, DirectoryCache } from "../../src/config.ts";
import { DiscordClient } from "../../src/discord.ts";
import type { Env } from "../../src/env.ts";
import { GitHubApp } from "../../src/github.ts";
import type { InteractionContext } from "../../src/registry.ts";
import type { Services } from "../../src/services.ts";
import type { Interaction, InteractionResponse } from "../../src/types.ts";
import { fakeContext, jsonResponse, makeEnv, mockFetch, type RecordedCall } from "../helpers.ts";

export const GUILD = "1494019459822653512";
export const APP = "1553826696673759344";

export const CHANNEL_RX = "1700000000000000001";
export const CHANNEL_CHARGER = "1700000000000000002";
export const GEN_CHAT = "1700000000000000003";
/** The retired #receivers development forum, still on the server until it is deleted by hand. */
export const OLD_FORUM_RX = "1700000000000000004";
export const THREAD = "1700000000000000010";
export const THREAD_POWER = "1700000000000000011";
export const MESSAGE = "1700000000000000020";

export const ROLE_ADMIN = "1720000000000000001";
export const ROLE_REVIEWER = "1720000000000000002";
export const ROLE_MEMBER = "1720000000000000003";
export const ROLE_DEVELOPER = "1720000000000000004";
export const ROLE_BUILDER = "1720000000000000005";

export const ALICE = "1730000000000000001";
export const BOB = "1730000000000000002";

export const INSTALLATION = 77;
export const GH_TOKEN = "ghs_installation_token_value";

export const guildChannels = [
  { id: GEN_CHAT, type: 0, name: "gen-chat" },
  { id: CHANNEL_RX, type: 0, name: "rx" },
  { id: CHANNEL_CHARGER, type: 0, name: "charger" },
  { id: OLD_FORUM_RX, type: 15, name: "receivers", available_tags: [{ id: "1710000000000000001", name: "OpenRX" }] },
];

export const guildRoles = [
  { id: GUILD, name: "@everyone" },
  { id: ROLE_ADMIN, name: "admin" },
  { id: ROLE_REVIEWER, name: "reviewer" },
  { id: ROLE_MEMBER, name: "Member" },
  { id: ROLE_DEVELOPER, name: "developer" },
  { id: ROLE_BUILDER, name: "Verified Builder" },
];

export function rxThread(overrides: Record<string, unknown> = {}) {
  return {
    id: THREAD,
    type: 11,
    name: "OpenRX: Fix UART pinout on v2 (Rev. B)",
    parent_id: CHANNEL_RX,
    ...overrides,
  };
}

export type Handler = (call: RecordedCall, url: URL) => Response | Promise<Response> | undefined;

let rsaPem: Promise<string> | undefined;

function toPem(der: Uint8Array): string {
  let binary = "";
  for (const b of der) binary += String.fromCharCode(b);
  const lines = btoa(binary).match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

/** A generated RSA key for the GitHub App (made once per test file). */
export function appKey(): Promise<string> {
  rsaPem ??= (async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    return toPem(new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer));
  })();
  return rsaPem;
}

/** Guild reads, the App installation and its token; everything else goes to `handler`. */
function baseRoutes(call: RecordedCall, url: URL): Response | undefined {
  const key = `${call.method} ${url.pathname}`;
  if (key === `GET /api/v10/guilds/${GUILD}/channels`) return jsonResponse(guildChannels);
  if (key === `GET /api/v10/guilds/${GUILD}/roles`) return jsonResponse(guildRoles);
  if (/^GET \/repos\/OpenDrone-hw\/[^/]+\/installation$/.test(key)) return jsonResponse({ id: INSTALLATION });
  if (key === `POST /app/installations/${INSTALLATION}/access_tokens`) {
    return jsonResponse({ token: GH_TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
  }
  if (call.method === "PATCH" && url.pathname.endsWith("/messages/@original")) return jsonResponse({ id: "orig" });
  return undefined;
}

export interface Harness {
  services: Services;
  calls: RecordedCall[];
  env: Env;
  /** Runs everything passed to waitUntil. */
  settle(): Promise<void>;
  ctx(interaction: Interaction): InteractionContext;
  /** Calls made to one "METHOD path" (path without the API prefix or query). */
  find(method: string, path: string): RecordedCall[];
  /** Content of the last deferred-response edit. */
  lastEdit(): Record<string, unknown> | undefined;
}

export async function harness(handler: Handler = () => undefined, envOverrides: Partial<Env> = {}): Promise<Harness> {
  const env = makeEnv({ GITHUB_APP_PRIVATE_KEY: await appKey(), ...envOverrides });
  const mock = mockFetch(async (call) => {
    const url = new URL(call.url);
    const response = (await handler(call, url)) ?? baseRoutes(call, url);
    return response ?? jsonResponse({ message: `unmocked ${call.method} ${url.pathname}` }, 599);
  });
  const discord = new DiscordClient({ token: env.DISCORD_BOT_TOKEN, fetch: mock.fetch, sleep: async () => {} });
  const github = new GitHubApp({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY, fetch: mock.fetch });
  const directory = new Directory(discord, env.GUILD_ID, { cache: new DirectoryCache() });
  const context = fakeContext();
  const services: Services = {
    env,
    waitUntil: (promise) => context.ctx.waitUntil(promise),
    discord,
    github,
    directory,
  };
  const strip = (u: string) => new URL(u).pathname.replace(/^\/api\/v10/, "");
  return {
    services,
    calls: mock.calls,
    env,
    settle: () => context.settle(),
    ctx: (interaction) => ({ interaction, services }),
    find: (method, path) => mock.calls.filter((c) => c.method === method && strip(c.url) === path),
    lastEdit() {
      const edits = mock.calls.filter((c) => c.method === "PATCH" && c.url.includes("/messages/@original"));
      return edits.at(-1)?.body as Record<string, unknown> | undefined;
    },
  };
}

export interface MemberSpec {
  id?: string;
  username?: string;
  roles?: string[];
  permissions?: string;
}

function member(spec: MemberSpec = {}) {
  return {
    user: { id: spec.id ?? ALICE, username: spec.username ?? "alice" },
    roles: spec.roles ?? [ROLE_MEMBER],
    permissions: spec.permissions ?? "2048",
  };
}

export function slash(
  name: string,
  options: Array<{ name: string; value: unknown; type?: number; focused?: boolean }> = [],
  extra: { member?: MemberSpec; channel?: Record<string, unknown> | null; type?: number } = {},
): Interaction {
  const channel = extra.channel === undefined ? rxThread() : extra.channel;
  const interaction: Interaction = {
    id: "1600000000000000001",
    application_id: APP,
    type: extra.type ?? 2,
    token: "interaction-token",
    guild_id: GUILD,
    member: member(extra.member),
    data: { id: "1", name, type: 1, options: options.map((o) => ({ type: 3, ...o })) },
  };
  if (channel) {
    interaction.channel_id = String(channel.id);
    interaction.channel = channel;
  }
  return interaction;
}

export function messageCommand(
  name: string,
  message: Record<string, unknown>,
  extra: { member?: MemberSpec; channel?: Record<string, unknown> } = {},
): Interaction {
  const channel = extra.channel ?? rxThread();
  return {
    id: "1600000000000000002",
    application_id: APP,
    type: 2,
    token: "interaction-token",
    guild_id: GUILD,
    channel_id: String(channel.id),
    channel,
    member: member(extra.member),
    data: {
      id: "2",
      name,
      type: 3,
      target_id: String(message.id),
      resolved: { messages: { [String(message.id)]: { channel_id: String(channel.id), ...message } } },
    },
  };
}

/** The text of a response or deferred edit. */
export function text(value: InteractionResponse | Record<string, unknown> | undefined): string {
  if (!value) return "";
  const record = value as Record<string, unknown>;
  const data = "type" in record && "data" in record ? (record.data as Record<string, unknown> | undefined) : record;
  return typeof data?.content === "string" ? data.content : "";
}
