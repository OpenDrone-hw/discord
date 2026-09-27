/**
 * Message context menu "Approve build": reviewer or admin only (checked here,
 * whatever the command permissions in Server Settings allow). Gives the
 * message author the Verified Builder role and answers only the reviewer.
 */
import { DiscordError } from "../discord.ts";
import { defer } from "../interactions.ts";
import type { Command, InteractionContext } from "../registry.ts";
import { ApplicationCommandType } from "../types.ts";
import { targetMessage } from "./to-issue.ts";
import { ADMIN_PERMISSIONS, escapeMarkdown, guildOnly, hasRole, invokerId, invokerName, messageUrl } from "./util.ts";

export const COMMAND_NAME = "Approve build";
const UNKNOWN_MEMBER = 10007;
const MISSING_PERMISSIONS = 50013;
export const NOT_REVIEWER = "Only reviewers and admins can approve builds.";

async function approve(ctx: InteractionContext): Promise<string> {
  const { interaction, services } = ctx;
  if (!(await hasRole(ctx, ["reviewer", "admin"]))) return NOT_REVIEWER;

  const message = targetMessage(ctx);
  const author = message?.author;
  if (!message || !author) return "Discord did not send the message author.";
  if (author.bot || message.webhook_id) return "That message was posted by a bot or webhook.";
  if (author.id === invokerId(interaction)) return "You cannot approve your own build.";

  const roleName = services.directory.config.roles.verifiedBuilder;
  const roleId = await services.directory.roleId("verifiedBuilder");
  if (!roleId) return `The role ${roleName} does not exist on the server.`;

  const guildId = interaction.guild_id ?? services.env.GUILD_ID;
  const link = messageUrl(guildId, interaction.channel_id ?? message.channel_id ?? "", message.id);
  try {
    await services.discord.addMemberRole(guildId, author.id, roleId, `Approve build by ${invokerName(interaction)}: ${link}`);
  } catch (error) {
    if (error instanceof DiscordError && error.code === UNKNOWN_MEMBER) return "The author is no longer on the server.";
    if (error instanceof DiscordError && error.code === MISSING_PERMISSIONS) {
      return `The bot cannot give ${roleName}: its own role must be above ${roleName}.`;
    }
    throw error;
  }
  return `Gave ${roleName} to ${escapeMarkdown(author.username ?? author.id)} for ${link}.`;
}

export const approveBuildCommand: Command = {
  definition: {
    name: COMMAND_NAME,
    type: ApplicationCommandType.MESSAGE,
    default_member_permissions: ADMIN_PERMISSIONS,
    ...guildOnly(),
  },
  execute: (ctx) => defer(ctx, () => approve(ctx), { ephemeral: true }),
};
