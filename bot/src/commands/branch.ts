/**
 * /branch [repo]: run inside a thread of a product channel. Replies (only to the
 * invoker) with the commands to fork the repository and start a branch named
 * after the thread title, and the "Discussion:" line to put in the pull
 * request description so its activity comes to this thread.
 *
 * Only repositories mapped to the thread's channel are accepted or offered by
 * autocomplete: the GitHub module ignores a "Discussion:" line that points at
 * a thread in another channel.
 */
import { defer } from "../interactions.ts";
import type { Command, InteractionContext } from "../registry.ts";
import { ApplicationCommandType } from "../types.ts";
import {
  branchSlug,
  code,
  parsePullThreadName,
  productThread,
  guildOnly,
  MEMBER_PERMISSIONS,
  resolveRepoName,
  stringOption,
  threadRepoChoices,
  threadUrl,
  truncate,
  wrongChannel,
} from "./util.ts";

export function branchInstructions(org: string, repo: string, branch: string, threadLink: string): string {
  return [
    `Work on **${repo}** for this thread:`,
    "```sh",
    `gh repo fork ${org}/${repo} --clone`,
    `cd ${repo}`,
    `git switch -c ${branch}`,
    "```",
    "Without the GitHub CLI: fork on github.com, then",
    "```sh",
    `git clone https://github.com/<your-user>/${repo}.git`,
    `cd ${repo}`,
    `git remote add upstream https://github.com/${org}/${repo}.git`,
    `git switch -c ${branch}`,
    "```",
    `KiCad boards and schematics cannot be merged: run \`/editing repo:${repo}\` first to see which open pull requests change them.`,
    "When you open the pull request, put this line in its description so its activity is posted here (without it the bot starts a separate thread):",
    "```",
    `Discussion: ${threadLink}`,
    "```",
    "If the pull request is already open, run `/link pr:<url>` in this thread instead.",
  ].join("\n");
}

async function branch(ctx: InteractionContext, repoOption: string | undefined): Promise<string> {
  const cfg = ctx.services.directory.config;
  const thread = await productThread(ctx);
  if (!thread) return "Run /branch inside a thread of a product channel.";

  let repo = null;
  if (repoOption) {
    repo = resolveRepoName(ctx, repoOption);
    if (!repo) {
      return `${code(truncate(repoOption, 100))} is not a repository in bot/config/repos.json. This channel covers: ${thread.repos.map((r) => r.repo).join(", ")}.`;
    }
    const refusal = wrongChannel(thread, repo, "/branch");
    if (refusal) return refusal;
  } else if (thread.named.length === 1) {
    repo = thread.named[0] ?? null;
  } else if (thread.repos.length === 1) {
    repo = thread.repos[0] ?? null;
  }
  if (!repo) {
    const options = (thread.named.length > 1 ? thread.named : thread.repos).map((r) => r.repo);
    return `This thread does not name one product. Run /branch repo:<name> with one of: ${options.join(", ")}.`;
  }
  const name = thread.thread.name ?? "";
  // A pull request thread's slug comes from the title, without the "<repo> #<n>:" prefix.
  const slug = branchSlug(parsePullThreadName(name)?.title ?? name, `thread-${thread.thread.id}`);
  const link = threadUrl(ctx.interaction.guild_id ?? ctx.services.env.GUILD_ID, thread.thread.id);
  return branchInstructions(cfg.org, repo.repo, slug, link);
}

export const branchCommand: Command = {
  definition: {
    name: "branch",
    type: ApplicationCommandType.CHAT_INPUT,
    description: "Fork and branch commands for this thread",
    options: [
      {
        type: 3,
        name: "repo",
        description: "Repository of this thread's channel, when the thread name does not name exactly one",
        required: false,
        autocomplete: true,
      },
    ],
    default_member_permissions: MEMBER_PERMISSIONS,
    ...guildOnly(),
  },
  execute(ctx) {
    const repo = stringOption(ctx.interaction, "repo");
    return defer(ctx, () => branch(ctx, repo || undefined), { ephemeral: true });
  },
  autocomplete: (ctx) => threadRepoChoices(ctx),
};
