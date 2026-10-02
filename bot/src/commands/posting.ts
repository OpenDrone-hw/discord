/**
 * /posting state:<on|off|status>: admin only. Flips the D1 half of the
 * GitHub-to-Discord kill switch (src/posting.ts) and reports both halves.
 * The DISCORD_POSTING secret wins when it says "off": /posting on cannot
 * override it, and the reply says so.
 */
import { ephemeral } from "../interactions.ts";
import type { Command, InteractionContext } from "../registry.ts";
import { postingState, setStoredPosting, type PostingState } from "../posting.ts";
import { ApplicationCommandType, type InteractionResponse } from "../types.ts";
import { ADMIN_PERMISSIONS, guildOnly, hasRole, invokerName, stringOption } from "./util.ts";

export const NOT_ADMIN = "Only admins can switch GitHub posting.";

export function describeState(state: PostingState): string {
  const head = state.enabled
    ? "GitHub posting to Discord is **on**."
    : "GitHub posting to Discord is **off**: deliveries are recorded as skipped and nothing is posted.";
  const lines = [head, `-# /posting switch: ${state.stored}. Worker secret DISCORD_POSTING: ${state.variable}.`];
  if (state.variable.toLowerCase() === "off") {
    lines.push("-# DISCORD_POSTING is off, which /posting cannot override; remove it with `npx wrangler secret delete DISCORD_POSTING`.");
  }
  return lines.join("\n");
}

async function run(ctx: InteractionContext): Promise<InteractionResponse> {
  if (!(await hasRole(ctx, ["admin"]))) return ephemeral(NOT_ADMIN);
  const env = ctx.services.env;
  const wanted = stringOption(ctx.interaction, "state") ?? "status";
  if (wanted === "on" || wanted === "off") {
    try {
      await setStoredPosting(env.DB, wanted, invokerName(ctx.interaction));
    } catch (error) {
      console.error("/posting could not write bot_settings:", error instanceof Error ? error.message : String(error));
      return ephemeral("Could not save the switch (D1 unavailable). Set the Worker secret DISCORD_POSTING to off instead.");
    }
    console.log(`/posting ${wanted} by ${invokerName(ctx.interaction)}`);
  }
  return ephemeral(describeState(await postingState(env)));
}

export const postingCommand: Command = {
  definition: {
    name: "posting",
    type: ApplicationCommandType.CHAT_INPUT,
    description: "Switch GitHub posting to Discord on or off (admins)",
    default_member_permissions: ADMIN_PERMISSIONS,
    ...guildOnly(),
    options: [
      {
        type: 3,
        name: "state",
        description: "on, off, or status (default)",
        required: false,
        choices: [
          { name: "on", value: "on" },
          { name: "off", value: "off" },
          { name: "status", value: "status" },
        ],
      },
    ],
  },
  execute: (ctx) => run(ctx),
};
