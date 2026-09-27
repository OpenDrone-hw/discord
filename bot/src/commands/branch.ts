/**
 * /branch [repo]: run inside a development forum thread. Replies (only to the
 * invoker) with the commands to fork the repository and start a branch named
 * after the thread title.
 */
import { defer } from "../interactions.ts";
import type { Command, InteractionContext } from "../registry.ts";
import { ApplicationCommandType } from "../types.ts";
import {
  branchSlug,
  code,
  forumThread,
  guildOnly,
  MEMBER_PERMISSIONS,
  repoChoices,
  resolveRepoName,
  stringOption,
} from "./util.ts";

export function branchInstructions(org: string, repo: string, branch: string): string {
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
    "Once your pull request is open, run `/link pr:<url>` in this thread.",
  ].join("\n");
}

async function branch(ctx: InteractionContext, repoOption: string | undefined): Promise<string> {
  const cfg = ctx.services.directory.config;
  const thread = await forumThread(ctx);
  if (!thread) return "Run /branch inside a thread of a development forum.";

  let repo = null;
  if (repoOption) {
    repo = resolveRepoName(ctx, repoOption);
    if (!repo) return `${code(repoOption)} is not a repository in bot/config/repos.json.`;
  } else if (thread.tagged.length === 1) {
    repo = thread.tagged[0] ?? null;
  } else if (thread.repos.length === 1) {
    repo = thread.repos[0] ?? null;
  }
  if (!repo) {
    const options = (thread.tagged.length > 1 ? thread.tagged : thread.repos).map((r) => r.repo);
    return `This thread does not name one product. Run /branch repo:<name> with one of: ${options.join(", ")}.`;
  }
  const slug = branchSlug(thread.thread.name ?? "", `thread-${thread.thread.id}`);
  return branchInstructions(cfg.org, repo.repo, slug);
}

export const branchCommand: Command = {
  definition: {
    name: "branch",
    type: ApplicationCommandType.CHAT_INPUT,
    description: "Fork and branch commands for this forum thread",
    options: [
      {
        type: 3,
        name: "repo",
        description: "Repository, when the thread has no single product tag",
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
  autocomplete: (ctx) => repoChoices(ctx),
};
