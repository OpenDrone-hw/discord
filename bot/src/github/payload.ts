/**
 * Typed views of the parts of GitHub webhook and REST payloads this module
 * reads. Payloads arrive as untyped JSON, so every field is checked here and
 * handlers never index the raw payload themselves.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function login(value: unknown): string {
  return (isRecord(value) && str(value.login)) || "someone";
}

export interface Repo {
  owner: string;
  name: string;
  fullName: string;
  htmlUrl: string;
  private: boolean;
  defaultBranch: string;
  topics: string[];
}

export function readRepo(value: unknown): Repo | null {
  if (!isRecord(value)) return null;
  const fullName = str(value.full_name);
  const name = str(value.name);
  if (!fullName || !name) return null;
  const owner = (isRecord(value.owner) && str(value.owner.login)) || fullName.split("/")[0] || "";
  return {
    owner,
    name,
    fullName,
    htmlUrl: str(value.html_url) ?? `https://github.com/${fullName}`,
    // A repository without the flag is treated as private: nothing leaks by default.
    private: value.private !== false,
    defaultBranch: str(value.default_branch) ?? "main",
    topics: Array.isArray(value.topics) ? value.topics.filter((t): t is string => typeof t === "string") : [],
  };
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  author: string;
  draft: boolean;
  state: string;
  merged: boolean;
  mergedBy: string | null;
  headSha: string;
  headRef: string;
  baseRef: string;
  additions: number | undefined;
  deletions: number | undefined;
  changedFiles: number | undefined;
}

export function readPull(value: unknown): PullRequest | null {
  if (!isRecord(value)) return null;
  const number = num(value.number);
  if (number === undefined) return null;
  const head = isRecord(value.head) ? value.head : {};
  const base = isRecord(value.base) ? value.base : {};
  return {
    number,
    title: str(value.title) ?? "",
    body: str(value.body) ?? "",
    htmlUrl: str(value.html_url) ?? "",
    author: login(value.user),
    draft: value.draft === true,
    state: str(value.state) ?? "open",
    merged: value.merged === true,
    mergedBy: isRecord(value.merged_by) ? login(value.merged_by) : null,
    headSha: str(head.sha) ?? "",
    headRef: str(head.ref) ?? "",
    baseRef: str(base.ref) ?? "",
    additions: num(value.additions),
    deletions: num(value.deletions),
    changedFiles: num(value.changed_files),
  };
}

export interface Review {
  state: string;
  body: string;
  author: string;
  htmlUrl: string;
}

export function readReview(value: unknown): Review | null {
  if (!isRecord(value)) return null;
  const state = str(value.state);
  if (!state) return null;
  return {
    state: state.toLowerCase(),
    body: str(value.body) ?? "",
    author: login(value.user),
    htmlUrl: str(value.html_url) ?? "",
  };
}

export interface CheckSuite {
  conclusion: string | null;
  headSha: string;
  headBranch: string | null;
  app: string;
  pullNumbers: number[];
}

export function readCheckSuite(value: unknown): CheckSuite | null {
  if (!isRecord(value)) return null;
  const pulls = Array.isArray(value.pull_requests) ? value.pull_requests : [];
  return {
    conclusion: str(value.conclusion) ?? null,
    headSha: str(value.head_sha) ?? "",
    headBranch: str(value.head_branch) ?? null,
    app: (isRecord(value.app) && str(value.app.name)) || "checks",
    pullNumbers: pulls.map((p) => (isRecord(p) ? num(p.number) : undefined)).filter((n): n is number => n !== undefined),
  };
}

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number | undefined;
}

export interface Release {
  tag: string;
  name: string;
  body: string;
  htmlUrl: string;
  prerelease: boolean;
  draft: boolean;
  author: string;
  assets: ReleaseAsset[];
}

export function readRelease(value: unknown): Release | null {
  if (!isRecord(value)) return null;
  const tag = str(value.tag_name);
  if (!tag) return null;
  const assets = Array.isArray(value.assets) ? value.assets : [];
  return {
    tag,
    name: str(value.name) || tag,
    body: str(value.body) ?? "",
    htmlUrl: str(value.html_url) ?? "",
    prerelease: value.prerelease === true,
    draft: value.draft === true,
    author: login(value.author),
    assets: assets
      .map((a): ReleaseAsset | null => {
        if (!isRecord(a)) return null;
        const name = str(a.name);
        const url = str(a.browser_download_url);
        return name && url ? { name, url, size: num(a.size) } : null;
      })
      .filter((a): a is ReleaseAsset => a !== null),
  };
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  author: string;
  state: string;
  /** True for the issue side of a pull request (issue_comment on a PR). */
  isPull: boolean;
}

export function readIssue(value: unknown): Issue | null {
  if (!isRecord(value)) return null;
  const number = num(value.number);
  if (number === undefined) return null;
  return {
    number,
    title: str(value.title) ?? "",
    body: str(value.body) ?? "",
    htmlUrl: str(value.html_url) ?? "",
    author: login(value.user),
    state: str(value.state) ?? "open",
    isPull: value.pull_request !== undefined && value.pull_request !== null,
  };
}

export interface IssueCommentEvent {
  body: string;
  htmlUrl: string;
  author: string;
  /** True for GitHub Apps and other bot accounts. */
  isBot: boolean;
}

export function readIssueComment(value: unknown): IssueCommentEvent | null {
  if (!isRecord(value)) return null;
  const user = isRecord(value.user) ? value.user : {};
  const author = login(value.user);
  return {
    body: str(value.body) ?? "",
    htmlUrl: str(value.html_url) ?? "",
    author,
    isBot: user.type === "Bot" || author.endsWith("[bot]"),
  };
}

export function senderLogin(payload: Record<string, unknown>): string {
  return login(payload.sender);
}

export function installationId(payload: Record<string, unknown>): number | undefined {
  return isRecord(payload.installation) ? num(payload.installation.id) : undefined;
}
