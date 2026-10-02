/**
 * Issues in public repositories: one thread per issue in the product channel
 * config/repos.json maps the repository to, plus lines in #git-feed.
 *
 * | Event.action           | Issue thread                                 | #git-feed |
 * |------------------------|----------------------------------------------|-----------|
 * | issues.opened          | started, issue card                          | line      |
 * | issues.reopened        | started if missing, card                     | no        |
 * | issues.closed          | close card, then the thread is archived      | line      |
 * | issue_comment.created  | started if missing (open issue), one line    | no        |
 *
 * Comments by bot accounts post nothing. An issue_comment on a pull request
 * (payload.issue.pull_request set) is ignored: pull requests have their own
 * threads (pulls.ts). Private repositories post nothing; a payload without
 * the repository's private flag counts as private (payload.ts readRepo).
 *
 * The thread is named "<repo> issue #<n>: <title>", cut to 100 characters,
 * and auto-archives after a week, Discord's maximum. While the issue is open
 * the thread stays open: any message the bot posts unarchives it, and
 * scheduled() unarchives open-issue threads Discord archived in a quiet
 * week, without posting anything.
 *
 * D1 table github_issues (TABLE_SQL, created on first use) maps an issue to
 * its thread and state. Without the DB binding no thread is started.
 */
import { DiscordError } from "../discord.ts";
import { errorText } from "../interactions.ts";
import type { GitHubEventContext } from "../registry.ts";
import type { Services } from "../services.ts";
import type { MessagePayload } from "../types.ts";
import { makeScope, postToChannel, postToThread, runAll, type Scope } from "./context.ts";
import { Colors, card, escapeMarkdown, feedLine, firstParagraph, link, oneLine, plainExcerpt, truncate } from "./format.ts";
import { isRecord, readIssue, readIssueComment, str, type Issue } from "./payload.ts";
import { AUTO_ARCHIVE_MINUTES, MAX_THREAD_NAME, THREAD_ALREADY_CREATED } from "./thread-link.ts";

export const ISSUE_ACTIONS = ["opened", "reopened", "closed"];
/** Longest issue summary on a card and longest comment excerpt in a thread line. */
export const MAX_SUMMARY = 300;
/** Open-issue threads checked per scheduled run, oldest check first. */
export const MAX_UNARCHIVE_CHECKS = 50;

export const TABLE_SQL = `CREATE TABLE IF NOT EXISTS github_issues (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  thread_id TEXT,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo, number)
)`;

export interface IssueRow {
  repo: string;
  number: number;
  threadId: string | null;
  state: string;
}

const tableReady = new WeakMap<D1Database, Promise<unknown>>();

export class IssueStore {
  readonly #db: D1Database;
  readonly #now: () => number;

  constructor(db: D1Database, now: () => number = () => Date.now()) {
    this.#db = db;
    this.#now = now;
  }

  async #ready(): Promise<void> {
    let ready = tableReady.get(this.#db);
    if (!ready) {
      ready = this.#db.prepare(TABLE_SQL).run();
      tableReady.set(this.#db, ready);
      ready.catch(() => tableReady.delete(this.#db));
    }
    await ready;
  }

  async get(repo: string, number: number): Promise<IssueRow | null> {
    await this.#ready();
    const row = await this.#db
      .prepare("SELECT repo, number, thread_id, state FROM github_issues WHERE repo = ? AND number = ?")
      .bind(repo.toLowerCase(), number)
      .first<{ repo: string; number: number; thread_id: string | null; state: string }>();
    return row ? { repo: row.repo, number: Number(row.number), threadId: row.thread_id, state: row.state } : null;
  }

  /** Inserts or updates the row; a thread id of undefined keeps the stored one. */
  async put(repo: string, number: number, state: string, threadId?: string | null): Promise<void> {
    await this.#ready();
    const keep = threadId === undefined ? 1 : 0;
    await this.#db
      .prepare(
        `INSERT INTO github_issues (repo, number, thread_id, state, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (repo, number) DO UPDATE SET
           thread_id = CASE WHEN ? = 1 THEN github_issues.thread_id ELSE excluded.thread_id END,
           state = excluded.state, updated_at = excluded.updated_at`,
      )
      .bind(repo.toLowerCase(), number, threadId ?? null, state, this.#now(), keep)
      .run();
  }

  /** Sets the state of a known issue; unknown issues are left alone. */
  async setState(repo: string, number: number, state: string): Promise<void> {
    await this.#ready();
    await this.#db
      .prepare("UPDATE github_issues SET state = ?, updated_at = ? WHERE repo = ? AND number = ?")
      .bind(state, this.#now(), repo.toLowerCase(), number)
      .run();
  }

  /** Open issues with a thread, least recently touched first. */
  async openThreads(limit: number): Promise<IssueRow[]> {
    await this.#ready();
    const result = await this.#db
      .prepare(
        "SELECT repo, number, thread_id, state FROM github_issues WHERE state = 'open' AND thread_id IS NOT NULL ORDER BY updated_at LIMIT ?",
      )
      .bind(limit)
      .all<{ repo: string; number: number; thread_id: string; state: string }>();
    return (result.results ?? []).map((r) => ({ repo: r.repo, number: Number(r.number), threadId: r.thread_id, state: r.state }));
  }

  /** Marks the row as checked now, so the next run starts with other issues. */
  async touch(repo: string, number: number): Promise<void> {
    await this.#db
      .prepare("UPDATE github_issues SET updated_at = ? WHERE repo = ? AND number = ?")
      .bind(this.#now(), repo, number)
      .run();
  }

  async forgetThread(repo: string, number: number): Promise<void> {
    await this.#db
      .prepare("UPDATE github_issues SET thread_id = NULL, updated_at = ? WHERE repo = ? AND number = ?")
      .bind(this.#now(), repo, number)
      .run();
  }
}

export function issueStoreFor(db: D1Database | undefined): IssueStore | null {
  return db && typeof db.prepare === "function" ? new IssueStore(db) : null;
}

/** "<repo> issue #<number>: <title>", cut to Discord's 100 characters. */
export function issueThreadName(repo: string, issue: Pick<Issue, "number" | "title">): string {
  return truncate(`${repo} issue #${issue.number}: ${oneLine(issue.title)}`, MAX_THREAD_NAME);
}

function heading(scope: Scope, issue: Issue): string {
  return `### ${link(`${scope.repo.name} issue #${issue.number}: ${issue.title}`, issue.htmlUrl)}`;
}

export function issueStarter(scope: Scope, issue: Issue): MessagePayload {
  return feedLine(
    `Issue **${escapeMarkdown(scope.repo.name)}** #${issue.number} by ${escapeMarkdown(issue.author)}: ${link(issue.title, issue.htmlUrl)}`,
  );
}

export function issueCard(scope: Scope, issue: Issue, actor: string, text: string, color: number, details: boolean): MessagePayload {
  return card({
    color,
    blocks: [
      heading(scope, issue),
      `**${escapeMarkdown(actor)}** ${text}`,
      details ? firstParagraph(issue.body, MAX_SUMMARY) : "",
    ],
    button: { label: "Open on GitHub", url: issue.htmlUrl },
  });
}

function closedText(reason: string | undefined): { text: string; color: number } {
  if (reason === "not_planned") return { text: "closed this issue as not planned", color: Colors.neutral };
  if (reason === "duplicate") return { text: "closed this issue as a duplicate", color: Colors.neutral };
  return { text: "closed this issue as completed", color: Colors.merged };
}

export function commentLine(author: string, body: string, url: string): MessagePayload {
  const excerpt = oneLine(plainExcerpt(body, MAX_SUMMARY));
  return feedLine(`**${escapeMarkdown(author)}** ${link("commented", url)}${excerpt ? `: ${excerpt}` : ""}`);
}

function feedText(scope: Scope, issue: Issue, verb: string, actor: string): string {
  return `**${escapeMarkdown(scope.repo.name)}** issue #${issue.number} ${verb} by ${escapeMarkdown(actor)}: ${link(issue.title, issue.htmlUrl)}`;
}

interface IssueThread {
  threadId: string;
  created: boolean;
}

/** The issue's thread from D1, else (when `create`) one started from a starter message in the product channel. */
async function issueThread(scope: Scope, store: IssueStore, issue: Issue, create: boolean): Promise<IssueThread | null> {
  const row = await store.get(scope.repo.fullName, issue.number);
  if (row?.threadId) return { threadId: row.threadId, created: false };
  if (!create) return null;
  const { directory, discord } = scope.services;
  const resolved = await directory.resolveRepo(scope.repo.fullName);
  if (!resolved) return null;

  const starterId = await scope.once("issue-starter", async () => (await discord.sendMessage(resolved.channelId, issueStarter(scope, issue))).id);
  if (!starterId) return null;
  const threadId = await scope.once("issue-thread", async () => {
    try {
      const thread = await discord.startThread(
        resolved.channelId,
        starterId,
        { name: issueThreadName(scope.repo.name, issue), auto_archive_duration: AUTO_ARCHIVE_MINUTES },
        `GitHub ${scope.repo.fullName} issue #${issue.number}`,
      );
      return thread.id;
    } catch (error) {
      // A retried step after the thread was started: the thread id is the message id.
      if (error instanceof DiscordError && error.code === THREAD_ALREADY_CREATED) return starterId;
      throw error;
    }
  });
  if (!threadId) return null;
  await store.put(scope.repo.fullName, issue.number, "open", threadId);
  return { threadId, created: true };
}

async function archive(services: Services, threadId: string): Promise<void> {
  try {
    await services.discord.editChannel(threadId, { archived: true }, "GitHub issue closed");
  } catch (error) {
    if (error instanceof DiscordError && (error.status === 404 || error.status === 403)) {
      console.warn(`issue thread ${threadId} could not be archived: ${error.message}`);
      return;
    }
    throw error;
  }
}

function storeOrWarn(scope: Scope): IssueStore | null {
  const store = issueStoreFor(scope.services.env.DB);
  if (!store) console.warn(`${scope.repo.fullName}: no DB binding; issue threads are off`);
  return store;
}

export async function handleIssue(ctx: GitHubEventContext): Promise<void> {
  const scope = makeScope(ctx);
  const issue = readIssue(ctx.payload.issue);
  const action = ctx.action ?? "";
  if (!scope || !issue || issue.isPull || scope.repo.private || !ISSUE_ACTIONS.includes(action)) return;
  const store = storeOrWarn(scope);
  const tasks: Array<() => Promise<unknown>> = [];
  const label = `issues.${action} ${scope.repo.fullName}#${issue.number}`;

  if (action === "closed") {
    const closed = closedText(stateReason(ctx.payload.issue));
    if (store) {
      tasks.push(async () => {
        const thread = await issueThread(scope, store, issue, false);
        await store.setState(scope.repo.fullName, issue.number, "closed");
        if (!thread) return;
        await scope.once("card", () =>
          postToThread(scope.services, thread.threadId, issueCard(scope, issue, scope.sender, closed.text, closed.color, false)),
        );
        await scope.once("archive", () => archive(scope.services, thread.threadId));
      });
    }
    tasks.push(() => scope.once("feed", () => postToChannel(scope.services, "gitFeed", feedLine(feedText(scope, issue, "closed", scope.sender)))));
    await runAll(label, tasks);
    return;
  }

  const opened = action === "opened";
  if (store) {
    tasks.push(async () => {
      const thread = await issueThread(scope, store, issue, true);
      await store.put(scope.repo.fullName, issue.number, "open");
      if (!thread) return;
      const actor = opened ? issue.author : scope.sender;
      const text = opened ? "opened this issue" : "reopened this issue";
      await scope.once("card", () =>
        postToThread(scope.services, thread.threadId, issueCard(scope, issue, actor, text, Colors.open, opened || thread.created)),
      );
    });
  }
  if (opened) {
    tasks.push(() => scope.once("feed", () => postToChannel(scope.services, "gitFeed", feedLine(feedText(scope, issue, "opened", issue.author)))));
  }
  await runAll(label, tasks);
}

function stateReason(value: unknown): string | undefined {
  return isRecord(value) ? str(value.state_reason) : undefined;
}

export async function handleIssueComment(ctx: GitHubEventContext): Promise<void> {
  const scope = makeScope(ctx);
  const issue = readIssue(ctx.payload.issue);
  const comment = readIssueComment(ctx.payload.comment);
  if (!scope || !issue || !comment || issue.isPull || scope.repo.private || comment.isBot) return;
  const store = storeOrWarn(scope);
  if (!store) return;
  const open = issue.state === "open";
  const thread = await issueThread(scope, store, issue, open);
  if (!thread) return;
  await runAll(`issue_comment ${scope.repo.fullName}#${issue.number}`, [
    async () => {
      if (thread.created) {
        await scope.once("card", () =>
          postToThread(scope.services, thread.threadId, issueCard(scope, issue, issue.author, "opened this issue", Colors.open, true)),
        );
      }
    },
    () => scope.once("comment", () => postToThread(scope.services, thread.threadId, commentLine(comment.author, comment.body, comment.htmlUrl))),
  ]);
}

/**
 * Kill switch off (src/posting.ts): keeps the stored state of known issues
 * current so scheduled() does not reopen a closed issue's thread later.
 */
export async function trackIssueState(ctx: GitHubEventContext): Promise<void> {
  const scope = makeScope(ctx);
  const issue = readIssue(ctx.payload.issue);
  const action = ctx.action ?? "";
  if (!scope || !issue || issue.isPull || scope.repo.private || !ISSUE_ACTIONS.includes(action)) return;
  const store = issueStoreFor(scope.services.env.DB);
  await store?.setState(scope.repo.fullName, issue.number, action === "closed" ? "closed" : "open");
}

/**
 * Unarchives the threads of open issues that Discord auto-archived. Posts
 * nothing. A thread that no longer exists is forgotten, so the next event of
 * the issue starts a new one; a locked thread is left alone.
 */
export async function unarchiveOpenIssueThreads(services: Services, store: IssueStore): Promise<number> {
  let reopened = 0;
  for (const row of await store.openThreads(MAX_UNARCHIVE_CHECKS)) {
    const threadId = row.threadId as string;
    try {
      const channel = await services.discord.getChannel(threadId);
      const meta = (channel.thread_metadata ?? {}) as { archived?: boolean; locked?: boolean };
      if (meta.archived && !meta.locked) {
        await services.discord.editChannel(threadId, { archived: false }, `GitHub ${row.repo}#${row.number} is still open`);
        reopened++;
      }
      await store.touch(row.repo, row.number);
    } catch (error) {
      if (error instanceof DiscordError && error.status === 404) {
        await store.forgetThread(row.repo, row.number);
        continue;
      }
      console.error(`issue thread ${threadId} (${row.repo}#${row.number}) check failed:`, errorText(error));
      await store.touch(row.repo, row.number).catch(() => {});
    }
  }
  return reopened;
}
