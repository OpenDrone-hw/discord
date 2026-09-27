/**
 * Linked-role refresh after GitHub events that change a user's facts.
 *
 * | Event.action                                 | Login refreshed           | Fact that changed          |
 * |----------------------------------------------|---------------------------|----------------------------|
 * | pull_request.closed with merged true         | the PR author             | merged_prs                 |
 * | organization.member_added, member_removed    | membership.user           | org_member (and maintainer)|
 * | membership.added, removed (scope team)       | member                    | maintainer                 |
 *
 * Only events of the organisation in config/repos.json count; logins that
 * are not plain GitHub user logins (e.g. "dependabot[bot]") are skipped.
 *
 * Each of these handlers is registered next to the posting handlers, so
 * src/webhooks.ts runs it in its own waitUntil promise after the 202 reply:
 * the refresh never delays the reply or the Discord cards. A refresh that
 * fails is logged and swallowed, and one that has not settled after
 * REFRESH_DEADLINE_MS is logged as unfinished so the log line is written
 * before Cloudflare cancels the work 30 s after the reply. The refresh
 * itself takes up to 10 s waiting for another refresh of the same user plus
 * about seven subrequests (src/linked-roles/index.ts), which the invocation
 * shares with the posting handlers of the same delivery. After a failed
 * refresh the cron picks the user up once their last refresh is older than
 * 24 h (src/linked-roles/context.ts, DEFAULT_STALE_AFTER_SECONDS).
 *
 * merged_prs comes from GitHub search, which indexes a merge asynchronously.
 * A refresh right after pull_request.closed therefore passes minMergedPrs 1
 * (knownFacts): the author's first merged PR reaches Discord as 1, so a
 * linked role requiring merged_prs >= 1 is granted even when search still
 * says 0. For an
 * author who already had merged PRs the count can stay one short until the
 * next refresh (their next merge or membership event, or the cron after 24 h).
 *
 * A redelivery refreshes again; pushing the current facts twice is harmless,
 * so these handlers do not use the github_deliveries guard.
 */
import { errorText } from "../interactions.ts";
import { refreshLinkedUser, type KnownFacts, type RefreshResult } from "../linked-roles/index.ts";
import type { GitHubEventContext, GitHubHandler } from "../registry.ts";
import type { Services } from "../services.ts";
import { isRecord, readPull, readRepo, str } from "./payload.ts";

export type RefreshLinkedUser = (services: Services, githubLogin: string, known: KnownFacts) => Promise<RefreshResult>;

const defaultRefresh: RefreshLinkedUser = (services, githubLogin, known) =>
  refreshLinkedUser(services, githubLogin, {}, known);

/** Logged as unfinished after this; 5 s before Cloudflare's 30 s waitUntil limit. */
export const REFRESH_DEADLINE_MS = 25_000;
export const ORGANIZATION_ACTIONS = ["member_added", "member_removed"];
export const MEMBERSHIP_ACTIONS = ["added", "removed"];

const USER_LOGIN = /^[A-Za-z0-9-]{1,39}$/;

function sameOrg(a: string | undefined, org: string): boolean {
  return a !== undefined && a.toLowerCase() === org.toLowerCase();
}

function orgLogin(payload: Record<string, unknown>): string | undefined {
  return isRecord(payload.organization) ? str(payload.organization.login) : undefined;
}

function userLogin(value: unknown): string | null {
  const login = isRecord(value) ? str(value.login) : undefined;
  return login && USER_LOGIN.test(login) ? login : null;
}

/**
 * Facts this delivery proves regardless of GitHub search. A merged pull
 * request in the organisation gives its author at least one merged PR; search
 * indexes the merge asynchronously and can still return the old count when
 * the refresh runs a second after the webhook.
 */
export function knownFacts(ctx: Pick<GitHubEventContext, "event">): KnownFacts {
  return ctx.event === "pull_request" ? { minMergedPrs: 1 } : {};
}

/** The GitHub login whose linked-role facts this delivery changed, or null. */
export function refreshTarget(ctx: Pick<GitHubEventContext, "event" | "action" | "payload">, org: string): string | null {
  const { event, action, payload } = ctx;
  if (event === "pull_request") {
    if (action !== "closed") return null;
    const repo = readRepo(payload.repository);
    if (!repo || !sameOrg(repo.owner, org)) return null;
    const pull = readPull(payload.pull_request);
    if (!pull?.merged) return null;
    return userLogin(isRecord(payload.pull_request) ? payload.pull_request.user : undefined);
  }
  if (event === "organization") {
    if (!action || !ORGANIZATION_ACTIONS.includes(action) || !sameOrg(orgLogin(payload), org)) return null;
    return userLogin(isRecord(payload.membership) ? payload.membership.user : undefined);
  }
  if (event === "membership") {
    if (!action || !MEMBERSHIP_ACTIONS.includes(action) || payload.scope !== "team") return null;
    if (!sameOrg(orgLogin(payload), org)) return null;
    return userLogin(payload.member);
  }
  return null;
}

export interface RefreshHandlerOptions {
  /** Default: refreshLinkedUser from src/linked-roles/index.ts. */
  refresh?: RefreshLinkedUser;
  deadlineMs?: number;
}

type Outcome = { kind: "done"; result: RefreshResult } | { kind: "failed"; error: unknown } | { kind: "late" };

async function runWithDeadline(work: Promise<RefreshResult>, deadlineMs: number): Promise<Outcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "late" }), deadlineMs);
  });
  try {
    return await Promise.race([
      work.then(
        (result): Outcome => ({ kind: "done", result }),
        (error: unknown): Outcome => ({ kind: "failed", error }),
      ),
      late,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Refreshes the target of one delivery; never throws. */
export async function refreshForDelivery(ctx: GitHubEventContext, options: RefreshHandlerOptions = {}): Promise<void> {
  const login = refreshTarget(ctx, ctx.services.directory.config.org);
  if (!login) return;
  const refresh = options.refresh ?? defaultRefresh;
  const label = `linked-roles refresh for ${login} after ${ctx.event}.${ctx.action ?? "-"} delivery ${ctx.delivery ?? "?"}`;
  let work: Promise<RefreshResult>;
  try {
    work = refresh(ctx.services, login, knownFacts(ctx));
  } catch (error) {
    work = Promise.reject(error);
  }
  const deadlineMs = options.deadlineMs ?? REFRESH_DEADLINE_MS;
  const outcome = await runWithDeadline(work, deadlineMs);
  if (outcome.kind === "failed") console.error(`${label} failed:`, errorText(outcome.error));
  else if (outcome.kind === "late") console.error(`${label} did not finish within ${deadlineMs} ms`);
  else if (outcome.result.status !== "not-linked") console.log(`${label}: ${outcome.result.status}`);
}

export function refreshHandlers(options: RefreshHandlerOptions = {}): GitHubHandler[] {
  const handle = (ctx: GitHubEventContext) => refreshForDelivery(ctx, options);
  return [
    { event: "pull_request", actions: ["closed"], handle },
    { event: "organization", actions: ORGANIZATION_ACTIONS, handle },
    { event: "membership", actions: MEMBERSHIP_ACTIONS, handle },
  ];
}
