/**
 * KiCad collision guard.
 *
 * KiCad board and schematic files (.kicad_pcb, .kicad_sch) cannot be merged,
 * so two open pull requests in one repository that change the same one are a
 * real conflict: whichever merges second has to redo its layout work. On
 * pull_request opened, reopened, ready_for_review and synchronize the guard
 * compares this PR's KiCad files with every other open PR in the repository.
 *
 * For each overlapping pair it posts one PR comment on the PR that triggered
 * the check and a warning card in both PRs' threads. The comment ends
 * with a hidden marker naming the pair and the files:
 *
 *   <!-- opendrone-kicad-collision pair=12,15 files=board%2Fmain.kicad_pcb -->
 *
 * Before warning, the guard reads the bot's markers on both PRs. A pair is
 * warned again only when the overlap contains a file no earlier marker named,
 * so repeated pushes (synchronize) and redeliveries stay quiet. Only markers
 * in comments by a Bot account count. Private repositories, and every
 * repository while the posting kill switch is off (src/posting.ts), get the
 * PR comment but no Discord warning.
 */
import type { Scope } from "./context.ts";
import { postToThread } from "./context.ts";
import { Colors, card, code, link } from "./format.ts";
import type { IssueComment } from "./api.ts";
import type { PullRequest } from "./payload.ts";
import { linkedThread } from "./thread-link.ts";

export const KICAD_FILE = /\.kicad_(pcb|sch)$/i;
/** Other open PRs compared per check, to stay inside the 30 s handler budget. */
export const MAX_OTHER_PULLS = 25;
const CONCURRENCY = 4;
/** Files listed in one comment or card; the marker always names all of them. */
const MAX_LISTED_FILES = 15;
const MARKER = /<!-- opendrone-kicad-collision pair=(\d+),(\d+) files=([^\s]*) -->/g;

export function kicadFiles(files: readonly string[]): string[] {
  return files.filter((f) => KICAD_FILE.test(f)).sort();
}

export function pairKey(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a];
}

export function collisionMarker(a: number, b: number, files: readonly string[]): string {
  const [low, high] = pairKey(a, b);
  return `<!-- opendrone-kicad-collision pair=${low},${high} files=${files.map(encodeURIComponent).join("|")} -->`;
}

/** Files already warned about for the pair, from markers in the bot's comments. */
export function warnedFiles(comments: readonly IssueComment[], a: number, b: number): Set<string> {
  const [low, high] = pairKey(a, b);
  const warned = new Set<string>();
  for (const comment of comments) {
    if (!comment.isBot) continue;
    for (const match of comment.body.matchAll(MARKER)) {
      if (Number(match[1]) !== low || Number(match[2]) !== high) continue;
      for (const part of (match[3] ?? "").split("|")) {
        if (!part) continue;
        try {
          warned.add(decodeURIComponent(part));
        } catch {
          // A malformed marker names nothing.
        }
      }
    }
  }
  return warned;
}

function fileList(files: readonly string[]): string {
  const shown = files.slice(0, MAX_LISTED_FILES).map((f) => `- ${code(f)}`);
  if (files.length > MAX_LISTED_FILES) shown.push(`- and ${files.length - MAX_LISTED_FILES} more`);
  return shown.join("\n");
}

export function collisionComment(other: PullRequest, overlap: readonly string[], thisNumber: number): string {
  return [
    `**KiCad collision:** this pull request and #${other.number} both change:`,
    "",
    fileList(overlap),
    "",
    "KiCad files cannot be merged. Agree in the Discord threads which pull request goes first; " +
      "the other one then redoes its changes on top of the merged result.",
    "",
    collisionMarker(thisNumber, other.number, overlap),
  ].join("\n");
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
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

function warningCard(scope: Scope, other: PullRequest, overlap: readonly string[]): ReturnType<typeof card> {
  return card({
    color: Colors.warning,
    blocks: [
      `### KiCad collision with ${link(`${scope.repo.name} #${other.number}: ${other.title}`, other.htmlUrl)}`,
      `Both pull requests change:\n${fileList(overlap)}`,
      `KiCad files cannot be merged. Agree here which one goes first; the other redoes its changes on top.`,
    ],
    button: { label: "Open the other PR", url: other.htmlUrl },
  });
}

/**
 * Compares `pull` with the other open PRs and warns about new overlaps.
 * `threadId` is this PR's verified thread when the caller already has
 * it; otherwise the PR body's link is verified here. The other PR's link is
 * always verified (linkedThread) before anything is posted to it.
 */
export async function checkCollisions(
  scope: Scope,
  pull: PullRequest,
  threadId: string | null,
  options: { discord?: boolean } = {},
): Promise<void> {
  const discord = options.discord ?? true;
  const mine = kicadFiles(await scope.api.pullFiles(pull.number));
  if (mine.length === 0) return;

  const others = (await scope.api.openPulls()).filter((p) => p.number !== pull.number);
  if (others.length > MAX_OTHER_PULLS) {
    console.warn(`${scope.repo.fullName}: ${others.length} open PRs, KiCad guard compares the newest ${MAX_OTHER_PULLS}`);
  }
  const compared = others.sort((a, b) => b.number - a.number).slice(0, MAX_OTHER_PULLS);
  const mineSet = new Set(mine);
  const overlaps = await mapLimit(compared, CONCURRENCY, async (other) => ({
    other,
    overlap: kicadFiles(await scope.api.pullFiles(other.number)).filter((f) => mineSet.has(f)),
  }));

  const colliding = overlaps.filter((o) => o.overlap.length > 0);
  if (colliding.length === 0) return;
  const myComments = await scope.api.comments(pull.number);
  let myThread: string | null | undefined = threadId ?? undefined;

  for (const { other, overlap } of colliding) {
    const warned = warnedFiles([...myComments, ...(await scope.api.comments(other.number))], pull.number, other.number);
    if (overlap.every((f) => warned.has(f))) continue;

    await scope.api.comment(pull.number, collisionComment(other, overlap, pull.number));
    if (scope.repo.private || !discord) continue;
    myThread ??= await linkedThread(scope, pull.body);
    const otherThread = await linkedThread(scope, other.body);
    if (myThread) await postToThread(scope.services, myThread, warningCard(scope, other, overlap));
    if (otherThread && otherThread !== myThread) {
      await postToThread(scope.services, otherThread, warningCard(scope, pull, overlap));
    }
  }
}

