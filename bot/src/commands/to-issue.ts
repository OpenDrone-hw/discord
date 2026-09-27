/**
 * Message context menu "To GitHub issue": members only, on a message in a
 * development forum thread. Opens a modal prefilled with the message text;
 * on submit it creates an issue in the repository mapped from the forum (the
 * thread's product tag preselects it) with a link back to the message, and
 * replies to the message with the issue link. Private repositories are
 * refused on submit unless the invoker is staff (admin or developer).
 *
 * The modal is the initial response, so the checks before it must finish
 * inside Discord's 3 s: they get PREPARE_TIMEOUT_MS, and a slower Discord API
 * answer gets a "try again" reply while the name cache warms.
 */
import { defer, ephemeral, errorText } from "../interactions.ts";
import type { Command, ComponentHandler, InteractionContext } from "../registry.ts";
import { ApplicationCommandType, InteractionResponseType, type InteractionResponse } from "../types.ts";
import {
  forumThread,
  guildOnly,
  hasRole,
  invokerName,
  MEMBER_PERMISSIONS,
  MEMBER_ROLES,
  messageUrl,
  repoRequest,
  STAFF_ROLES,
  truncate,
  within,
  type ThreadContext,
} from "./util.ts";

export const COMMAND_NAME = "To GitHub issue";
export const PREFIX = "to-issue";
export const PREPARE_TIMEOUT_MS = 2_200;
export const TITLE_MAX = 256;
export const BODY_MAX = 4_000;
const SNOWFLAKE = /^\d{15,25}$/;

export const NOT_MEMBER = "Only members can file GitHub issues.";
export const NOT_THREAD = "Use this on a message in a thread of a development forum.";
export const privateRefusal = (repo: string) => `${repo} is private; only developers can file issues in it.`;
export const SLOW = "Discord was slow to answer. Try again in a moment.";

interface TargetMessage {
  id: string;
  channel_id?: string;
  webhook_id?: string;
  content?: string;
  author?: { id: string; username?: string; bot?: boolean };
  attachments?: Array<{ filename?: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The message a message context-menu command was used on. */
export function targetMessage(ctx: InteractionContext): TargetMessage | null {
  const data = ctx.interaction.data;
  const messages = isRecord(data?.resolved) ? data.resolved.messages : undefined;
  if (!data?.target_id || !isRecord(messages)) return null;
  const message = messages[data.target_id];
  return isRecord(message) && typeof message.id === "string" ? (message as unknown as TargetMessage) : null;
}

/** First non-empty line of the message, without markdown markers. */
export function suggestedTitle(content: string): string {
  const clean = (l: string) => l.replace(/\*\*|__|~~|`|\|\|/g, "").replace(/^[\s>#*_-]+/, "").trim();
  const line = content.split("\n").map(clean).find(Boolean) ?? "";
  return truncate(line, 100);
}

export function suggestedBody(message: TargetMessage): string {
  const parts = [message.content ?? ""];
  const files = (message.attachments ?? []).map((a) => a.filename).filter(Boolean);
  if (files.length > 0) parts.push(`Attachments in the Discord message: ${files.join(", ")}`);
  return truncate(parts.filter(Boolean).join("\n\n"), BODY_MAX);
}

export function issueModal(
  customId: string,
  message: TargetMessage,
  thread: ThreadContext,
): InteractionResponse {
  const preselected = thread.tagged.length === 1 ? thread.tagged[0]?.repo : undefined;
  const candidates = thread.tagged.length > 1 ? thread.tagged : thread.repos;
  const title = suggestedTitle(message.content ?? "");
  const body = suggestedBody(message);
  const titleInput: Record<string, unknown> = {
    type: 4,
    custom_id: "title",
    style: 1,
    min_length: 1,
    max_length: TITLE_MAX,
    required: true,
  };
  if (title) titleInput.value = title;
  const bodyInput: Record<string, unknown> = { type: 4, custom_id: "body", style: 2, max_length: BODY_MAX, required: false };
  if (body) bodyInput.value = body;
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: customId,
      title: COMMAND_NAME,
      components: [
        {
          type: 18,
          label: "Repository",
          component: {
            type: 3,
            custom_id: "repo",
            min_values: 1,
            max_values: 1,
            required: true,
            options: candidates.slice(0, 25).map((r) => ({ label: r.repo, value: r.repo, default: r.repo === preselected })),
          },
        },
        { type: 18, label: "Title", component: titleInput },
        { type: 18, label: "Description", description: "A link to the Discord message is added below it.", component: bodyInput },
      ],
    },
  };
}

/** Values of a modal submission by custom_id, from Label or legacy Action Row layouts. */
export function modalValues(components: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isRecord(node)) return;
    if (typeof node.custom_id === "string") {
      if (typeof node.value === "string") out.set(node.custom_id, [node.value]);
      else if (Array.isArray(node.values)) out.set(node.custom_id, node.values.filter((v): v is string => typeof v === "string"));
    }
    walk(node.component);
    walk(node.components);
  };
  walk(components);
  return out;
}

export function issueBody(text: string, link: string, author: string, filer: string): string {
  const footer = `From [a Discord message](${link}) by ${author}, filed by ${filer} with the OpenDrone Discord bot.`;
  const main = text.trim();
  return main ? `${main}\n\n---\n${footer}\n` : `${footer}\n`;
}

async function prepare(ctx: InteractionContext): Promise<{ member: boolean; thread: ThreadContext | null }> {
  const [member, thread] = await Promise.all([hasRole(ctx, MEMBER_ROLES), forumThread(ctx)]);
  return { member, thread };
}

async function execute(ctx: InteractionContext): Promise<InteractionResponse> {
  const message = targetMessage(ctx);
  const channelId = ctx.interaction.channel_id;
  if (!message || !channelId) return ephemeral("Discord did not send the message.");
  const prepared = await within(prepare(ctx), PREPARE_TIMEOUT_MS);
  if (!prepared) return ephemeral(SLOW);
  if (!prepared.member) return ephemeral(NOT_MEMBER);
  if (!prepared.thread || prepared.thread.repos.length === 0) return ephemeral(NOT_THREAD);
  const customId = `${PREFIX}:${channelId}:${message.id}:${message.author?.id ?? "0"}`;
  return issueModal(customId, message, prepared.thread);
}

async function authorName(ctx: InteractionContext, authorId: string): Promise<string> {
  if (!SNOWFLAKE.test(authorId)) return "a Discord user";
  try {
    const user = await ctx.services.discord.request<{ username?: string }>("GET", `/users/${authorId}`);
    return user.username ?? "a Discord user";
  } catch (error) {
    console.error("to-issue: could not read the message author:", errorText(error));
    return "a Discord user";
  }
}

async function submit(ctx: InteractionContext, channelId: string, messageId: string, authorId: string): Promise<string> {
  const { interaction, services } = ctx;
  const cfg = services.directory.config;
  if (!(await hasRole(ctx, MEMBER_ROLES))) return NOT_MEMBER;
  const thread = await forumThread(ctx, channelId);
  if (!thread) return NOT_THREAD;

  const values = modalValues(interaction.data?.components);
  const repoName = values.get("repo")?.[0] ?? "";
  const repo = thread.repos.find((r) => r.repo === repoName);
  if (!repo) return `${repoName || "That repository"} is not discussed in #${thread.forum.name ?? "this forum"}.`;
  const title = (values.get("title")?.[0] ?? "").trim().slice(0, TITLE_MAX);
  if (!title) return "The issue needs a title.";
  const text = (values.get("body")?.[0] ?? "").slice(0, BODY_MAX);

  // Private repositories are staff-only: the App installation could write to
  // them for anyone, and the reply in the thread would expose the issue.
  const meta = await repoRequest<{ private?: boolean }>(ctx, repo.repo, "GET", `/repos/${cfg.org}/${repo.repo}`);
  if (meta.private !== false && !(await hasRole(ctx, STAFF_ROLES))) return privateRefusal(repo.repo);

  const guildId = interaction.guild_id ?? services.env.GUILD_ID;
  const link = messageUrl(guildId, channelId, messageId);
  const body = issueBody(text, link, await authorName(ctx, authorId), invokerName(interaction));
  const issue = await repoRequest<{ number: number; html_url: string }>(ctx, repo.repo, "POST", `/repos/${cfg.org}/${repo.repo}/issues`, {
    body: { title, body },
  });

  try {
    await services.discord.sendMessage(channelId, {
      content: `Filed as ${repo.repo}#${issue.number}: <${issue.html_url}>`,
      message_reference: { message_id: messageId, channel_id: channelId, fail_if_not_exists: false },
    });
  } catch (error) {
    console.error("to-issue: could not reply in the thread:", errorText(error));
  }
  return `Created ${repo.repo}#${issue.number}: <${issue.html_url}>`;
}

export const toIssueCommand: Command = {
  definition: {
    name: COMMAND_NAME,
    type: ApplicationCommandType.MESSAGE,
    default_member_permissions: MEMBER_PERMISSIONS,
    ...guildOnly(),
  },
  execute,
};

export const toIssueModal: ComponentHandler = {
  prefix: PREFIX,
  handle(ctx) {
    const [, channelId = "", messageId = "", authorId = ""] = (ctx.interaction.data?.custom_id ?? "").split(":");
    if (!SNOWFLAKE.test(channelId) || !SNOWFLAKE.test(messageId)) return ephemeral("This form is out of date.");
    return defer(ctx, () => submit(ctx, channelId, messageId, authorId), { ephemeral: true });
  },
};
