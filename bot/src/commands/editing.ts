/**
 * /editing repo:<name>: open pull requests in a repository that change KiCad
 * boards or schematics (.kicad_pcb, .kicad_sch), who opened them and which
 * files they touch. KiCad files cannot be merged, so two pull requests
 * changing one file is a real conflict; those files are listed first.
 */
import { GitHubError } from "../github.ts";
import { defer, ephemeral } from "../interactions.ts";
import type { Command, InteractionContext } from "../registry.ts";
import { ApplicationCommandType, MessageFlags, type MessagePayload } from "../types.ts";
import {
  code,
  escapeMarkdown,
  fitLines,
  guildOnly,
  hasRole,
  MEMBER_PERMISSIONS,
  repoChoices,
  repoRequest,
  resolveRepoName,
  STAFF_ROLES,
  stringOption,
  truncate,
} from "./util.ts";

export const KICAD_FILE = /\.kicad_(pcb|sch)$/i;
/** Open pull requests read per call (one page). */
export const MAX_PULLS = 100;
/** Changed-file pages read per pull request (100 files each; GitHub lists at most 3000). */
export const MAX_FILE_PAGES = 3;
const CONCURRENCY = 5;

interface Pull {
  number: number;
  title: string;
  html_url: string;
  draft?: boolean;
  user?: { login?: string } | null;
}

interface PullFile {
  filename: string;
  previous_filename?: string;
}

export interface KiCadPull {
  number: number;
  title: string;
  url: string;
  author: string;
  draft: boolean;
  files: string[];
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

async function kicadFiles(ctx: InteractionContext, repo: string, number: number): Promise<string[]> {
  const org = ctx.services.directory.config.org;
  const found = new Set<string>();
  for (let page = 1; page <= MAX_FILE_PAGES; page++) {
    const files = await repoRequest<PullFile[]>(ctx, repo, "GET", `/repos/${org}/${repo}/pulls/${number}/files`, {
      query: { per_page: 100, page },
    });
    for (const file of files) {
      for (const name of [file.filename, file.previous_filename]) {
        if (name && KICAD_FILE.test(name)) found.add(name);
      }
    }
    if (files.length < 100) break;
  }
  return [...found].sort();
}

/** Open pull requests changing KiCad files, oldest first, and whether the pull list was cut at MAX_PULLS. */
export async function kicadPulls(
  ctx: InteractionContext,
  repo: string,
): Promise<{ pulls: KiCadPull[]; open: number; truncated: boolean }> {
  const org = ctx.services.directory.config.org;
  const open = await repoRequest<Pull[]>(ctx, repo, "GET", `/repos/${org}/${repo}/pulls`, {
    query: { state: "open", per_page: MAX_PULLS, sort: "created", direction: "asc" },
  });
  const withFiles = await mapLimited(open, CONCURRENCY, async (pull) => ({
    number: pull.number,
    title: pull.title,
    url: pull.html_url,
    author: pull.user?.login ?? "unknown",
    draft: pull.draft === true,
    files: await kicadFiles(ctx, repo, pull.number),
  }));
  return { pulls: withFiles.filter((p) => p.files.length > 0), open: open.length, truncated: open.length >= MAX_PULLS };
}

/** The reply text for /editing. */
export function formatEditing(
  org: string,
  repo: string,
  result: { pulls: KiCadPull[]; open: number; truncated: boolean },
): string {
  const { pulls, open, truncated } = result;
  const scope = truncated ? `the first ${MAX_PULLS} open pull requests` : `${open} open pull request${open === 1 ? "" : "s"}`;
  if (pulls.length === 0) {
    return `No open pull request in **${repo}** changes a .kicad_pcb or .kicad_sch file (checked ${scope}).`;
  }
  const lines = [`**${repo}**: ${pulls.length} of ${scope} change KiCad files.`];

  const byFile = new Map<string, number[]>();
  for (const pull of pulls) for (const file of pull.files) byFile.set(file, [...(byFile.get(file) ?? []), pull.number]);
  const shared = [...byFile].filter(([, numbers]) => numbers.length > 1);
  if (shared.length > 0) {
    lines.push("", "Changed by more than one pull request (cannot be merged together):");
    for (const [file, numbers] of shared) lines.push(`- ${code(file)}: ${numbers.map((n) => `#${n}`).join(", ")}`);
  }

  lines.push("");
  for (const pull of pulls) {
    const draft = pull.draft ? " (draft)" : "";
    const files = pull.files.map(code).join(", ");
    lines.push(
      `- [#${pull.number}](<${pull.url}>) ${escapeMarkdown(truncate(pull.title, 80))}${draft}, by ${code(pull.author)}: ${files}`,
    );
  }
  lines.push("", `https://github.com/${org}/${repo}/pulls`);
  return fitLines(lines);
}

async function editing(ctx: InteractionContext, repoName: string): Promise<MessagePayload | string> {
  const cfg = ctx.services.directory.config;
  const repo = resolveRepoName(ctx, repoName);
  if (!repo) return `${code(truncate(repoName, 100))} is not a repository in bot/config/repos.json.`;

  let meta: { private?: boolean };
  try {
    meta = await repoRequest<{ private?: boolean }>(ctx, repo.repo, "GET", `/repos/${cfg.org}/${repo.repo}`);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return `${cfg.org}/${repo.repo} was not found on GitHub.`;
    throw error;
  }
  if (meta.private && !(await hasRole(ctx, STAFF_ROLES))) {
    return `${repo.repo} is private; only developers can list its pull requests here.`;
  }
  const content = formatEditing(cfg.org, repo.repo, await kicadPulls(ctx, repo.repo));
  return { content, flags: MessageFlags.SUPPRESS_EMBEDS };
}

export const editingCommand: Command = {
  definition: {
    name: "editing",
    type: ApplicationCommandType.CHAT_INPUT,
    description: "Open pull requests that change KiCad boards or schematics",
    options: [
      {
        type: 3,
        name: "repo",
        description: "Repository",
        required: true,
        autocomplete: true,
      },
    ],
    default_member_permissions: MEMBER_PERMISSIONS,
    ...guildOnly(),
  },
  execute(ctx) {
    const repo = stringOption(ctx.interaction, "repo");
    if (!repo) return ephemeral("Give the repository: /editing repo:<name>.");
    return defer(ctx, () => editing(ctx, repo), { ephemeral: true });
  },
  autocomplete: (ctx) => repoChoices(ctx),
};
