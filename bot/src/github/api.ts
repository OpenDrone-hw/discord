/**
 * GitHub REST calls this module makes, as the App installation that sent the
 * webhook. Pagination is bounded so a handler stays inside the 30 s
 * waitUntil budget.
 */
import type { GitHubApp } from "../github.ts";
import { isRecord, num, readPull, str, type PullRequest, type Repo } from "./payload.ts";

export const PER_PAGE = 100;
/** GitHub lists at most 3000 files per pull request. */
export const MAX_FILE_PAGES = 30;
export const MAX_PULL_PAGES = 3;
export const MAX_COMMENT_PAGES = 5;

export interface IssueComment {
  id: number;
  body: string;
  isBot: boolean;
}

export class RepoApi {
  readonly repo: Repo;
  readonly #github: () => GitHubApp;
  readonly #installationId: number | undefined;

  /** `github` is called on the first request, so events that never call GitHub do not need the App secrets. */
  constructor(github: () => GitHubApp, repo: Repo, installationId: number | undefined) {
    this.#github = github;
    this.repo = repo;
    this.#installationId = installationId;
  }

  async #installation(): Promise<string | number> {
    return this.#installationId ?? this.#github().installationForRepo(this.repo.owner, this.repo.name);
  }

  get #base(): string {
    return `/repos/${this.repo.owner}/${this.repo.name}`;
  }

  async #request<T>(method: string, path: string, options: { body?: unknown; query?: Record<string, string | number> } = {}): Promise<T> {
    return this.#github().request<T>(await this.#installation(), method, `${this.#base}${path}`, options);
  }

  async #pages(path: string, maxPages: number, query: Record<string, string | number> = {}): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const items = await this.#request<unknown>("GET", path, { query: { ...query, per_page: PER_PAGE, page } });
      if (!Array.isArray(items)) break;
      out.push(...items);
      if (items.length < PER_PAGE) break;
    }
    return out;
  }

  async pull(number: number): Promise<PullRequest | null> {
    return readPull(await this.#request("GET", `/pulls/${number}`));
  }

  async setPullBody(number: number, body: string): Promise<void> {
    await this.#request("PATCH", `/pulls/${number}`, { body: { body } });
  }

  /** Paths a pull request touches, including the old path of a renamed file. */
  async pullFiles(number: number): Promise<string[]> {
    const files = new Set<string>();
    for (const item of await this.#pages(`/pulls/${number}/files`, MAX_FILE_PAGES)) {
      if (!isRecord(item)) continue;
      const name = str(item.filename);
      const previous = str(item.previous_filename);
      if (name) files.add(name);
      if (previous) files.add(previous);
    }
    return [...files];
  }

  async openPulls(): Promise<PullRequest[]> {
    const items = await this.#pages("/pulls", MAX_PULL_PAGES, { state: "open" });
    return items.map(readPull).filter((p): p is PullRequest => p !== null);
  }

  async comments(number: number): Promise<IssueComment[]> {
    const items = await this.#pages(`/issues/${number}/comments`, MAX_COMMENT_PAGES);
    return items
      .map((item): IssueComment | null => {
        if (!isRecord(item)) return null;
        const id = num(item.id);
        if (id === undefined) return null;
        const user = isRecord(item.user) ? item.user : {};
        return { id, body: str(item.body) ?? "", isBot: user.type === "Bot" };
      })
      .filter((c): c is IssueComment => c !== null);
  }

  async comment(number: number, body: string): Promise<void> {
    await this.#request("POST", `/issues/${number}/comments`, { body: { body } });
  }
}
