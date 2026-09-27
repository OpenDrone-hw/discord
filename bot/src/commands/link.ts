/**
 * /link pr:<url>: run inside a development forum thread. Adds
 * "Discussion: <thread url>" to the pull request description, which the
 * GitHub module reads to post PR events into this thread. The invoker gets
 * an ephemeral answer; a successful link is also announced in the thread.
 *
 * The GitHub module creates a forum post and writes the line for every new
 * pull request that has none, usually before anyone can run /link. /link
 * therefore replaces an existing line when its thread was created by this
 * bot (owner_id is the application id) or no longer exists, and leaves a
 * note in the replaced post. A line pointing at a thread a person started,
 * or outside this server, is never replaced. Pull requests of private
 * repositories are refused for everyone: nothing of theirs is posted to Discord.
 * A repository mapped to another forum is refused before any GitHub call,
 * because the GitHub module ignores a line pointing outside the repo's forum.
 */
import { DiscordError } from "../discord.ts";
import { defer, ephemeral, errorText } from "../interactions.ts";
import type { Command, InteractionContext } from "../registry.ts";
import { GitHubError } from "../github.ts";
import { ApplicationCommandType, MessageFlags } from "../types.ts";
import {
  code,
  escapeMarkdown,
  forumThread,
  guildOnly,
  hasRole,
  invokerName,
  MEMBER_PERMISSIONS,
  MEMBER_ROLES,
  repoRequest,
  resolveRepoName,
  stringOption,
  threadUrl,
  truncate,
  wrongForum,
} from "./util.ts";

export const DISCUSSION_PREFIX = "Discussion:";
const DISCUSSION_LINE = /^[ \t]*Discussion:[ \t]*<?([^\s<>]+)>?[ \t]*$/m;
const THREAD_URL = /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(\d{17,20})\/(\d{17,20})(?:\/\d{17,20})?\/?$/i;

/** The URL on the pull request body's first "Discussion:" line, or null. */
export function discussionUrl(body: string | null | undefined): string | null {
  return DISCUSSION_LINE.exec(body ?? "")?.[1] ?? null;
}

/** Guild and thread id of a Discord channel URL, or null. */
export function parseThreadUrl(url: string): { guildId: string; threadId: string } | null {
  const match = THREAD_URL.exec(url);
  return match ? { guildId: match[1] as string, threadId: match[2] as string } : null;
}

/** Replaces the body's first "Discussion:" line with one naming `url`. */
export function replaceDiscussion(body: string, url: string): string {
  return body.replace(DISCUSSION_LINE, `${DISCUSSION_PREFIX} ${url}`);
}

/** Appends the "Discussion:" line to a pull request body. */
export function withDiscussion(body: string | null | undefined, url: string): string {
  const text = (body ?? "").replace(/\s+$/, "");
  return text ? `${text}\n\n${DISCUSSION_PREFIX} ${url}\n` : `${DISCUSSION_PREFIX} ${url}\n`;
}

export interface PullRef {
  owner: string;
  repo: string;
  number: number;
}

/** Parses https://github.com/<owner>/<repo>/pull/<n> (any suffix) or <repo>#<n>. */
export function parsePullRef(text: string, org: string): PullRef | null {
  const trimmed = text.trim();
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(trimmed);
  if (url) return { owner: url[1] as string, repo: url[2] as string, number: Number(url[3]) };
  const short = /^(?:([A-Za-z0-9-]+)\/)?([A-Za-z0-9._-]+)#(\d+)$/.exec(trimmed);
  if (short) return { owner: short[1] ?? org, repo: short[2] as string, number: Number(short[3]) };
  return null;
}

interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  base?: { repo?: { private?: boolean } };
}

/**
 * True when the thread was created by this bot (the GitHub module's automatic
 * post) or no longer exists. Any other answer, including an error, keeps the
 * existing link.
 */
async function replaceableThread(ctx: InteractionContext, threadId: string): Promise<boolean> {
  const botId = ctx.services.env.APPLICATION_ID || ctx.interaction.application_id;
  try {
    const thread = await ctx.services.discord.getChannel(threadId);
    return typeof thread.owner_id === "string" && thread.owner_id === botId;
  } catch (error) {
    return error instanceof DiscordError && error.status === 404;
  }
}

/** Tells readers of the bot-created post where the discussion went. Failure is logged only. */
async function noteMove(ctx: InteractionContext, threadId: string, label: string, url: string): Promise<void> {
  try {
    await ctx.services.discord.sendMessage(threadId, {
      content: `Discussion of ${label} moved to ${url}. New pull request activity is posted there.`,
      flags: MessageFlags.SUPPRESS_EMBEDS,
    });
  } catch (error) {
    if (!(error instanceof DiscordError && error.status === 404)) {
      console.error("link: could not leave a note in the replaced thread:", errorText(error));
    }
  }
}

async function link(ctx: InteractionContext, prText: string): Promise<string> {
  const { interaction, services } = ctx;
  const cfg = services.directory.config;
  if (!(await hasRole(ctx, MEMBER_ROLES))) return "Only members can link pull requests.";

  const thread = await forumThread(ctx);
  if (!thread) return "Run /link inside a thread of a development forum.";

  const ref = parsePullRef(prText, cfg.org);
  if (!ref || !Number.isSafeInteger(ref.number) || ref.number < 1) {
    return `${code(truncate(prText, 100))} is not a pull request link. Use https://github.com/${cfg.org}/<repo>/pull/<number>.`;
  }
  const repo = resolveRepoName(ctx, `${ref.owner}/${ref.repo}`);
  if (!repo) return `${ref.owner}/${ref.repo} is not an ${cfg.org} repository the bot knows (bot/config/repos.json).`;
  const refusal = wrongForum(thread, repo, "/link");
  if (refusal) return refusal;

  const path = `/repos/${cfg.org}/${repo.repo}/pulls/${ref.number}`;
  let pull: PullRequest;
  try {
    pull = await repoRequest<PullRequest>(ctx, repo.repo, "GET", path);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return `${repo.repo}#${ref.number} does not exist.`;
    throw error;
  }
  // Private repositories never post to Discord (the GitHub module drops their
  // events), so a link would promise activity that never comes and the thread
  // announcement would show a private title to every member. A missing flag
  // counts as private.
  if (pull.base?.repo?.private !== false) {
    return `${repo.repo} is private. Private repositories post nothing to Discord, so /link does not link their pull requests.`;
  }

  const url = threadUrl(interaction.guild_id ?? services.env.GUILD_ID, thread.thread.id);
  const label = `[${repo.repo}#${pull.number}](<${pull.html_url}>) ${escapeMarkdown(truncate(pull.title, 150))}`;
  const existing = discussionUrl(pull.body);
  if (existing === url) return `This thread is already linked to ${label}.`;
  let replaced: string | null = null;
  if (existing !== null) {
    const guildId = interaction.guild_id ?? services.env.GUILD_ID;
    const target = parseThreadUrl(existing);
    const replaceable = target !== null && target.guildId === guildId && (await replaceableThread(ctx, target.threadId));
    if (!replaceable) {
      return `${repo.repo}#${pull.number} already names another discussion: <${existing}>. Edit the pull request description to change it.`;
    }
    replaced = target.threadId;
  }
  const body = existing !== null ? replaceDiscussion(pull.body ?? "", url) : withDiscussion(pull.body, url);
  await repoRequest(ctx, repo.repo, "PATCH", path, { body: { body } });
  if (replaced !== null) await noteMove(ctx, replaced, label, url);
  await services.discord.sendMessage(thread.thread.id, {
    content: `${escapeMarkdown(invokerName(interaction))} linked this thread to ${label}. Pull request activity will be posted here.`,
    flags: MessageFlags.SUPPRESS_EMBEDS,
  });
  return `Linked this thread to ${label}.`;
}

export const linkCommand: Command = {
  definition: {
    name: "link",
    type: ApplicationCommandType.CHAT_INPUT,
    description: "Link this forum thread to a pull request",
    options: [
      {
        type: 3,
        name: "pr",
        description: "Pull request URL, e.g. https://github.com/OpenDrone-hw/OpenRX/pull/12",
        required: true,
        max_length: 200,
      },
    ],
    default_member_permissions: MEMBER_PERMISSIONS,
    ...guildOnly(),
  },
  execute(ctx) {
    const pr = stringOption(ctx.interaction, "pr");
    if (!pr) return ephemeral("Give the pull request URL: /link pr:<url>.");
    return defer(ctx, () => link(ctx, pr), { ephemeral: true });
  },
};
