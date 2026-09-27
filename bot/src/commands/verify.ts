/**
 * /verify: explains Linked Roles and links the verification URL. The URL is
 * the application's role_connections_verification_url (Developer Portal,
 * General Information), read from GET /applications/@me and cached per isolate,
 * so no Worker URL is configured anywhere else.
 */
import type { DiscordClient } from "../discord.ts";
import { defer } from "../interactions.ts";
import type { Command, InteractionContext } from "../registry.ts";
import { ApplicationCommandType, type MessagePayload } from "../types.ts";
import { guildOnly, MEMBER_PERMISSIONS } from "./util.ts";

const CACHE_MS = 300_000;
let cached: { at: number; url: string | null } | undefined;

/** Test hook: forgets the cached verification URL. */
export function clearVerificationUrlCache(): void {
  cached = undefined;
}

export async function verificationUrl(discord: DiscordClient, now = Date.now()): Promise<string | null> {
  if (cached && now - cached.at < CACHE_MS) return cached.url;
  const app = await discord.request<{ role_connections_verification_url?: string | null }>("GET", "/applications/@me");
  const url = app.role_connections_verification_url;
  const value = typeof url === "string" && /^https:\/\//.test(url) ? url : null;
  cached = { at: now, url: value };
  return value;
}

export function verifyMessage(
  url: string | null,
  org: string,
  roles: { contributor: string; maintainer: string; owner: string },
): MessagePayload {
  const text = [
    "**Linked Roles** give roles from facts Discord cannot see. After you verify, the bot reports to Discord:",
    "",
    `- how many of your pull requests were merged in ${org}`,
    `- whether you are a member of the ${org} GitHub organisation`,
    `- whether you maintain an ${org} repository`,
    "- whether you own an OpenDrone product (filled in by the storefront)",
    "",
    `Roles such as **${roles.contributor}**, **${roles.maintainer}** and **${roles.owner}** require some of these; the exact requirements are set in Server Settings, Roles.`,
    "",
    "1. Open the verification page and sign in with Discord, then with GitHub. The browser must be signed in to discord.com as this same account; the page names the account before the GitHub step, and \"Not you?\" on the Discord page switches it.",
    "2. In this server, open the server name menu, then Linked Roles, and claim the roles you qualify for.",
  ];
  if (!url) {
    text.push("", "Verification is not set up yet: the application has no Linked Roles verification URL.");
    return { content: text.join("\n") };
  }
  return {
    content: text.join("\n"),
    components: [{ type: 1, components: [{ type: 2, style: 5, label: "Open verification page", url }] }],
  };
}

async function verify(ctx: InteractionContext): Promise<MessagePayload> {
  const { roles, org } = ctx.services.directory.config;
  const url = await verificationUrl(ctx.services.discord);
  return verifyMessage(url, org, { contributor: roles.contributor, maintainer: roles.maintainer, owner: roles.verifiedOwner });
}

export const verifyCommand: Command = {
  definition: {
    name: "verify",
    type: ApplicationCommandType.CHAT_INPUT,
    description: "Get Linked Roles from your GitHub contributions",
    default_member_permissions: MEMBER_PERMISSIONS,
    ...guildOnly(),
  },
  execute: (ctx) => defer(ctx, () => verify(ctx), { ephemeral: true }),
};
