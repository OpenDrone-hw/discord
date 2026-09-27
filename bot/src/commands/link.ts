/**
 * /link pr:<url>: run inside a development forum thread. Adds
 * "Discussion: <thread url>" to the pull request description, which the
 * GitHub module reads to post PR events into this thread. The invoker gets
 * an ephemeral answer; a successful link is also announced in the thread.
 */
import { defer, ephemeral } from "../interactions.ts";
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
  STAFF_ROLES,
  stringOption,
  threadUrl,
  truncate,
} from "./util.ts";

export const DISCUSSION_PREFIX = "Discussion:";
const DISCUSSION_LINE = /^Discussion:[ \t]*(\S+)[ \t]*$/m;

/** The URL on the pull request body's "Discussion:" line, or null. */
export function discussionUrl(body: string | null | undefined): string | null {
  return DISCUSSION_LINE.exec(body ?? "")?.[1] ?? null;
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
  if (repo.forum !== thread.forum.name) {
    return `${repo.repo} is discussed in #${repo.forum}; open or pick a thread there.`;
  }

  const path = `/repos/${cfg.org}/${repo.repo}/pulls/${ref.number}`;
  let pull: PullRequest;
  try {
    pull = await repoRequest<PullRequest>(ctx, repo.repo, "GET", path);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return `${repo.repo}#${ref.number} does not exist.`;
    throw error;
  }
  if (pull.base?.repo?.private && !(await hasRole(ctx, STAFF_ROLES))) {
    return `${repo.repo} is private; only developers can link its pull requests.`;
  }

  const url = threadUrl(interaction.guild_id ?? services.env.GUILD_ID, thread.thread.id);
  const label = `[${repo.repo}#${pull.number}](<${pull.html_url}>) ${escapeMarkdown(truncate(pull.title, 150))}`;
  const existing = discussionUrl(pull.body);
  if (existing === url) return `This thread is already linked to ${label}.`;
  if (existing !== null) {
    return `${repo.repo}#${pull.number} already names another discussion: <${existing}>. Edit the pull request description to change it.`;
  }
  await repoRequest(ctx, repo.repo, "PATCH", path, { body: { body: withDiscussion(pull.body, url) } });
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
