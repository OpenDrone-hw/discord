import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createGitHubModule } from "../../src/github/index.ts";
import { REFRESH_DEADLINE_MS, refreshTarget, type RefreshLinkedUser } from "../../src/github/linked-roles.ts";
import { createWorker } from "../../src/index.ts";
import { refreshLinkedUser, type RefreshResult } from "../../src/linked-roles/index.ts";
import { fakeContext, githubSignature } from "../helpers.ts";
import { harness as linkedRolesHarness, link } from "../linked-roles/harness.ts";
import { EXISTING_THREAD, FEED, FakeWorld, GUILD, ORG, harness, pullJson, repoPayload } from "./fakes.ts";

const LINK = `Discussion: https://discord.com/channels/${GUILD}/${EXISTING_THREAD}`;

let errors: MockInstance;
let logs: MockInstance;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  logs = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function errorLines(): string[] {
  return errors.mock.calls.map((c) => c.map(String).join(" "));
}

function merged(number: number, author = "alice", overrides: Record<string, unknown> = {}) {
  return pullJson("OpenRX", number, {
    body: LINK,
    state: "closed",
    merged: true,
    merged_by: { login: "carol" },
    user: { login: author },
    ...overrides,
  });
}

function closedPr(pull: object, extra: Record<string, unknown> = {}) {
  return { action: "closed", number: (pull as { number: number }).number, pull_request: pull, repository: repoPayload(), ...extra };
}

function orgEvent(action: string, login: string, org = ORG) {
  return { action, membership: { user: { login }, state: "active", role: "member" }, organization: { login: org } };
}

function teamEvent(action: string, login: string, extra: Record<string, unknown> = {}) {
  return {
    action,
    scope: "team",
    member: { login },
    team: { slug: "maintainers", name: "maintainers" },
    organization: { login: ORG },
    ...extra,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("refreshTarget", () => {
  const target = (event: string, action: string | undefined, payload: Record<string, unknown>) =>
    refreshTarget({ event, action, payload }, ORG);

  it("names the author of a merged pull request, not the merger or the sender", () => {
    const pull = merged(1, "alice");
    expect(target("pull_request", "closed", closedPr(pull, { sender: { login: "carol" } }))).toBe("alice");
  });

  it("ignores closes without merge, other actions and repositories outside the organisation", () => {
    expect(target("pull_request", "closed", closedPr(pullJson("OpenRX", 2, { state: "closed" })))).toBeNull();
    expect(target("pull_request", "opened", closedPr(merged(3)))).toBeNull();
    const foreign = { ...closedPr(merged(4)), repository: repoPayload("OpenRX", { full_name: "someone/OpenRX", owner: { login: "someone" } }) };
    expect(target("pull_request", "closed", foreign)).toBeNull();
    expect(target("pull_request", "closed", { action: "closed", pull_request: merged(5) })).toBeNull();
  });

  it("skips bot and malformed logins", () => {
    expect(target("pull_request", "closed", closedPr(merged(6, "dependabot[bot]")))).toBeNull();
    expect(target("pull_request", "closed", closedPr(merged(7, "a/../b")))).toBeNull();
    expect(target("pull_request", "closed", closedPr({ ...merged(8), user: null }))).toBeNull();
  });

  it("names the member on organisation membership changes in the configured organisation", () => {
    expect(target("organization", "member_added", orgEvent("member_added", "bob"))).toBe("bob");
    expect(target("organization", "member_removed", orgEvent("member_removed", "bob", ORG.toLowerCase()))).toBe("bob");
    expect(target("organization", "member_invited", orgEvent("member_invited", "bob"))).toBeNull();
    expect(target("organization", "member_added", orgEvent("member_added", "bob", "other-org"))).toBeNull();
    expect(target("organization", "member_added", { action: "member_added" })).toBeNull();
  });

  it("names the member on team membership changes only", () => {
    expect(target("membership", "added", teamEvent("added", "dana"))).toBe("dana");
    expect(target("membership", "removed", teamEvent("removed", "dana"))).toBe("dana");
    expect(target("membership", "added", teamEvent("added", "dana", { scope: "organization" }))).toBeNull();
    expect(target("membership", "added", teamEvent("added", "dana", { organization: { login: "other-org" } }))).toBeNull();
  });

  it("ignores every other event", () => {
    expect(target("push", undefined, { repository: repoPayload() })).toBeNull();
    expect(target("team", "deleted", { organization: { login: ORG } })).toBeNull();
  });
});

describe("refresh through the webhook", () => {
  it("refreshes the author of a merged PR and still posts the merge card and feed line", async () => {
    const { world, deliver } = await harness();
    const pull = world.addPull("OpenRX", merged(7, "alice"));
    const response = await deliver("pull_request", closedPr({ ...pull }, { sender: { login: "carol" } }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, handlers: 2 });
    expect(world.refreshed).toEqual(["alice"]);
    expect(world.refreshFacts).toEqual([{ minMergedPrs: 1 }]);
    expect(FakeWorld.text(world.messagesIn(EXISTING_THREAD)[0])).toContain("merged this pull request");
    expect(FakeWorld.text(world.messagesIn(FEED)[0])).toContain("#7 merged by carol");
    expect(errorLines()).toEqual([]);
  });

  it("does not refresh anyone when a PR is closed without merge", async () => {
    const { world, deliver } = await harness();
    const pull = world.addPull("OpenRX", pullJson("OpenRX", 8, { state: "closed" }));
    await deliver("pull_request", closedPr({ ...pull }));
    expect(world.refreshed).toEqual([]);
  });

  it("refreshes on organisation and team membership changes, with no Discord or GitHub call of its own", async () => {
    const { world, deliver } = await harness();
    expect((await deliver("organization", orgEvent("member_added", "bob"))).status).toBe(202);
    await deliver("organization", orgEvent("member_removed", "erin"));
    await deliver("membership", teamEvent("added", "dana"));
    await deliver("organization", orgEvent("member_invited", "frank"));
    expect(world.refreshed).toEqual(["bob", "erin", "dana"]);
    expect(world.refreshFacts).toEqual([{}, {}, {}]);
    expect(world.calls).toEqual([]);
    expect(errorLines()).toEqual([]);
  });

  it("answers 202 before the refresh settles", async () => {
    const pending = deferred<RefreshResult>();
    const started: string[] = [];
    const refresh: RefreshLinkedUser = (_services, login) => {
      started.push(login);
      return pending.promise;
    };
    const h = await harness({ refresh });
    const response = await h.send("organization", orgEvent("member_added", "bob"));
    expect(response.status).toBe(202);
    await Promise.resolve();
    expect(started).toEqual(["bob"]);
    pending.resolve({ status: "updated", discordId: "1", githubLogin: "bob" });
    await h.settle();
    expect(String(logs.mock.calls[0]?.[0])).toContain("linked-roles refresh for bob after organization.member_added");
    expect(String(logs.mock.calls[0]?.[0])).toContain(": updated");
  });

  it("logs a failed refresh and does not affect the reply or the other handlers", async () => {
    const refresh: RefreshLinkedUser = async () => {
      throw new Error("D1_ERROR: database unavailable");
    };
    const { world, deliver } = await harness({ refresh });
    const pull = world.addPull("OpenRX", merged(9, "alice"));
    const response = await deliver("pull_request", closedPr({ ...pull }), "delivery-fail");
    expect(response.status).toBe(202);
    expect(FakeWorld.text(world.messagesIn(FEED)[0])).toContain("#9 merged by carol");
    const lines = errorLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("linked-roles refresh for alice after pull_request.closed delivery delivery-fail failed:");
    expect(lines[0]).toContain("database unavailable");
    // Logged by the refresh handler itself, not reported as a failed handler by src/webhooks.ts.
    expect(lines[0]).not.toContain("(github) failed");
  });

  it("logs a refresh that throws synchronously", async () => {
    const refresh: RefreshLinkedUser = () => {
      throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set");
    };
    const { deliver } = await harness({ refresh });
    expect((await deliver("membership", teamEvent("removed", "dana"))).status).toBe(202);
    expect(errorLines()).toHaveLength(1);
    expect(errorLines()[0]).toContain("must be set");
  });

  it("logs a refresh that outlives the deadline instead of waiting for Cloudflare to cancel it", async () => {
    const refresh: RefreshLinkedUser = () => new Promise<RefreshResult>(() => {});
    const { deliver } = await harness({ refresh, refreshDeadlineMs: 5 });
    await deliver("organization", orgEvent("member_added", "bob"));
    expect(errorLines()).toHaveLength(1);
    expect(errorLines()[0]).toContain("linked-roles refresh for bob after organization.member_added");
    expect(errorLines()[0]).toContain("did not finish within 5 ms");
  });

  it("keeps the default deadline inside the 30 s waitUntil budget", () => {
    expect(REFRESH_DEADLINE_MS).toBeLessThan(30_000);
    expect(REFRESH_DEADLINE_MS).toBeGreaterThan(10_000);
  });

  it("stays quiet for logins nobody linked", async () => {
    const { world, deliver } = await harness();
    await deliver("organization", orgEvent("member_added", "bob"));
    expect(world.refreshed).toEqual(["bob"]);
    expect(logs).not.toHaveBeenCalled();
    expect(errorLines()).toEqual([]);
  });
});

describe("refresh end to end with the linked-roles module", () => {
  const DISCORD_ID = "111111111111111111";

  async function sendSigned(
    worker: ReturnType<typeof createWorker>,
    env: Parameters<NonNullable<ReturnType<typeof createWorker>["fetch"]>>[1],
    event: string,
    payload: Record<string, unknown>,
  ) {
    const context = fakeContext();
    const text = JSON.stringify({ installation: { id: 99 }, sender: { login: "octo-admin" }, ...payload });
    const request = new Request("https://bot.example.workers.dev/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": event,
        "X-GitHub-Delivery": `e2e-${event}`,
        "X-Hub-Signature-256": await githubSignature(env.GITHUB_WEBHOOK_SECRET, text),
      },
      body: text,
    });
    const response = await worker.fetch!(request as Request<unknown, IncomingRequestCfProperties>, env, context.ctx);
    await context.settle();
    return response;
  }

  function linkedWorker(h: Awaited<ReturnType<typeof linkedRolesHarness>>) {
    const module = createGitHubModule({
      linkedRoles: { refresh: (services, login, known) => refreshLinkedUser(services, login, h.options, known) },
    });
    return createWorker({ modules: [module], services: (_env, waitUntil) => ({ ...h.services, waitUntil }) });
  }

  it("pushes merged_prs 1 after a first merge that GitHub search has not indexed yet", async () => {
    const h = await linkedRolesHarness();
    expect((await link(h, DISCORD_ID, "alice")).status).toBe(200);
    expect(h.providers.roleConnections.get(DISCORD_ID)?.metadata).toMatchObject({ merged_prs: "0" });

    // The search fake keeps answering the pre-merge count (0) for alice.
    const response = await sendSigned(linkedWorker(h), h.env, "pull_request", closedPr(merged(12, "alice")));
    expect(response.status).toBe(202);
    expect(h.providers.mergedPrs.get("alice") ?? 0).toBe(0);
    expect(h.providers.roleConnections.get(DISCORD_ID)?.metadata).toEqual({
      merged_prs: "1",
      org_member: "0",
      maintainer: "0",
      owner: "0",
    });
    // This harness has no bot token, so only the posting handlers (merge card, feed line) fail.
    expect(errorLines().filter((line) => !line.includes("linked-roles used the bot client"))).toEqual([]);
    expect(String(logs.mock.calls.at(-1)?.[0])).toContain("linked-roles refresh for alice after pull_request.closed");
    expect(String(logs.mock.calls.at(-1)?.[0])).toContain(": updated");
  });

  it("pushes the search count after a merge once search reports more than the lower bound", async () => {
    const h = await linkedRolesHarness();
    expect((await link(h, DISCORD_ID, "alice")).status).toBe(200);
    h.providers.mergedPrs.set("alice", 6);
    await sendSigned(linkedWorker(h), h.env, "pull_request", closedPr(merged(13, "alice")));
    expect(h.providers.roleConnections.get(DISCORD_ID)?.metadata).toMatchObject({ merged_prs: "6" });
  });

  it("pushes new metadata for the linked Discord user when they join the organisation", async () => {
    const h = await linkedRolesHarness();
    expect((await link(h, DISCORD_ID, "alice")).status).toBe(200);
    expect(h.providers.roleConnections.get(DISCORD_ID)?.metadata).toMatchObject({ org_member: "0" });

    h.providers.orgMembers.add("alice");
    h.providers.mergedPrs.set("alice", 2);
    const worker = linkedWorker(h);

    const response = await sendSigned(worker, h.env, "organization", orgEvent("member_added", "Alice"));
    expect(response.status).toBe(202);
    expect(h.providers.roleConnections.get(DISCORD_ID)).toEqual({
      platform_name: "GitHub",
      platform_username: "alice",
      metadata: { merged_prs: "2", org_member: "1", maintainer: "0", owner: "0" },
    });
    expect(errorLines()).toEqual([]);
    expect(String(logs.mock.calls.at(-1)?.[0])).toContain("linked-roles refresh for Alice after organization.member_added");
  });
});
