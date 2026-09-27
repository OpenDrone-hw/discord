/**
 * Repository-level events: releases, lifecycle topic changes and pushes to
 * the default branch.
 *
 * | Event.action         | #announcements                 | #git-feed                  |
 * |----------------------|--------------------------------|----------------------------|
 * | release.published    | release card with asset links  | one line                   |
 * | repository.edited    | when the status-* topic moves  | one line                   |
 * | push                 | no                             | default branch only, not   |
 * |                      |                                | PR merges (already posted) |
 *
 * Private repositories post nothing.
 */
import type { GitHubEventContext } from "../registry.ts";
import { currentStatus, makeScope, postToChannel, runAll } from "./context.ts";
import {
  Colors,
  card,
  code,
  escapeMarkdown,
  feedLine,
  formatBytes,
  link,
  oneLine,
  releaseNotes,
  shortSha,
  truncate,
} from "./format.ts";
import { isRecord, readRelease, str, type Release, type Repo } from "./payload.ts";

const MAX_ASSETS = 10;
const ZERO_SHA = /^0+$/;
/** Head commit subjects GitHub writes for merge and squash merges of a PR. */
const PR_MERGE_SUBJECT = /^Merge pull request #\d+ |\(#\d+\)$/;

export function releaseCard(repo: Repo, release: Release) {
  const assets = release.assets.slice(0, MAX_ASSETS).map((a) => {
    const size = formatBytes(a.size);
    return `- ${link(a.name, a.url)}${size ? ` (${size})` : ""}`;
  });
  if (release.assets.length > MAX_ASSETS) assets.push(`- and ${release.assets.length - MAX_ASSETS} more on GitHub`);
  const named = release.name.includes(release.tag) ? release.name : `${release.name} (${release.tag})`;
  const title = named.toLowerCase().includes(repo.name.toLowerCase()) ? named : `${repo.name} ${named}`;
  return card({
    color: Colors.release,
    blocks: [
      `## ${link(title, release.htmlUrl)}`,
      `${release.prerelease ? "Pre-release" : "Release"} published by **${escapeMarkdown(release.author)}**`,
      releaseNotes(release.body, 1500),
      assets.length ? `**Downloads**\n${assets.join("\n")}` : "",
    ],
    button: { label: "Release on GitHub", url: release.htmlUrl },
  });
}

export async function handleRelease(ctx: GitHubEventContext): Promise<void> {
  const scope = makeScope(ctx);
  const release = readRelease(ctx.payload.release);
  if (!scope || !release || scope.repo.private || release.draft) return;
  const kind = release.prerelease ? "pre-release" : "release";
  const line = `**${escapeMarkdown(scope.repo.name)}** ${kind} ${link(release.name, release.htmlUrl)} published by ${escapeMarkdown(release.author)}`;
  await runAll(`release ${scope.repo.fullName} ${release.tag}`, [
    () => scope.once("announce", () => postToChannel(scope.services, "announcements", releaseCard(scope.repo, release))),
    () => scope.once("feed", () => postToChannel(scope.services, "gitFeed", feedLine(line))),
  ]);
}

/** Topics before the edit, from changes.topics.from; null when the topics did not change. */
export function previousTopics(payload: Record<string, unknown>): string[] | null {
  const changes = isRecord(payload.changes) ? payload.changes : null;
  const topics = changes && isRecord(changes.topics) ? changes.topics : null;
  if (!topics) return null;
  return Array.isArray(topics.from) ? topics.from.filter((t): t is string => typeof t === "string") : [];
}

export async function handleRepositoryEdited(ctx: GitHubEventContext): Promise<void> {
  const scope = makeScope(ctx);
  if (!scope || scope.repo.private) return;
  const before = previousTopics(ctx.payload);
  if (!before) return;
  const from = currentStatus(before);
  const to = currentStatus(scope.repo.topics);
  // A removed status without a new one is not announced.
  if (!to || to === from) return;
  const labels = scope.services.directory.config.lifecycleTags;
  const repoLink = link(scope.repo.name, scope.repo.htmlUrl);
  const change = from
    ? `moved from **${escapeMarkdown(labels[from])}** to **${escapeMarkdown(labels[to])}**`
    : `is now **${escapeMarkdown(labels[to])}**`;
  const announcement = card({
    color: Colors.release,
    blocks: [`### ${repoLink} ${change}`],
    button: { label: "Repository on GitHub", url: scope.repo.htmlUrl },
  });
  await runAll(`repository.edited ${scope.repo.fullName}`, [
    () => scope.once("announce", () => postToChannel(scope.services, "announcements", announcement)),
    () => scope.once("feed", () => postToChannel(scope.services, "gitFeed", feedLine(`**${repoLink}** ${change}`))),
  ]);
}

export async function handlePush(ctx: GitHubEventContext): Promise<void> {
  const scope = makeScope(ctx);
  if (!scope || scope.repo.private) return;
  const { payload } = ctx;
  if (str(payload.ref) !== `refs/heads/${scope.repo.defaultBranch}`) return;
  const after = str(payload.after) ?? "";
  if (payload.deleted === true || !after || ZERO_SHA.test(after)) return;
  const commits = Array.isArray(payload.commits) ? payload.commits : [];
  if (commits.length === 0) return;
  const head = isRecord(payload.head_commit) ? payload.head_commit : {};
  const subject = oneLine((str(head.message) ?? "").split("\n")[0] ?? "");
  if (PR_MERGE_SUBJECT.test(subject)) return;

  const compare = str(payload.compare) ?? `${scope.repo.htmlUrl}/commit/${after}`;
  const count = commits.length === 1 ? "1 commit" : `${commits.length} commits`;
  const text =
    `**${escapeMarkdown(scope.repo.name)}** ${escapeMarkdown(scope.sender)} pushed ${count} to ${code(scope.repo.defaultBranch)}: ` +
    `${link(truncate(subject || shortSha(after), 120), compare)}`;
  await scope.once("feed", () => postToChannel(scope.services, "gitFeed", feedLine(text)));
}
