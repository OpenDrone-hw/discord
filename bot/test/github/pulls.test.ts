import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { githubModule } from "../../src/github/index.ts";
import { Registry } from "../../src/registry.ts";
import { EXISTING_THREAD, FEED, FakeWorld, GUILD, harness, pullJson, repoPayload } from "./fakes.ts";

const LINK = `Discussion: https://discord.com/channels/${GUILD}/${EXISTING_THREAD}`;

let errors: MockInstance;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function prEvent(action: string, pull: object, extra: Record<string, unknown> = {}) {
  return { action, number: (pull as { number: number }).number, pull_request: pull, repository: repoPayload(), ...extra };
}

function discordCalls(world: FakeWorld) {
  return world.calls.filter((c) => c.url.startsWith("https://discord.com/"));
}

describe("module registration", () => {
  it("registers the handled events and actions", () => {
    const registry = new Registry([githubModule]);
    const names = (event: string, action?: string) => registry.githubHandlers(event, action).length;
    for (const action of ["opened", "reopened", "ready_for_review", "synchronize"]) {
      expect(names("pull_request", action)).toBe(1);
    }
    // closed: the linked-role refresh only.
    expect(names("pull_request", "closed")).toBe(1);
    expect(names("pull_request", "edited")).toBe(0);
    expect(names("pull_request", "labeled")).toBe(0);
    expect(names("pull_request_review", "submitted")).toBe(0);
    expect(names("check_suite", "completed")).toBe(1);
    expect(names("check_suite", "requested")).toBe(0);
    expect(names("release", "published")).toBe(1);
    expect(names("release", "created")).toBe(0);
    expect(names("repository", "edited")).toBe(1);
    expect(names("push", undefined)).toBe(1);
    expect(names("organization", "member_added")).toBe(1);
    expect(names("organization", "member_removed")).toBe(1);
    expect(names("organization", "member_invited")).toBe(0);
    expect(names("membership", "added")).toBe(1);
    expect(names("membership", "removed")).toBe(1);
  });
});

describe("pull requests post nothing to Discord", () => {
  it("on any action, linked or not, and never edits the PR body", async () => {
    const { world, deliver } = await harness();
    const fresh = world.addPull("OpenRX", pullJson("OpenRX", 12, { body: "Adds a u.FL." }));
    const linked = world.addPull("OpenRX", pullJson("OpenRX", 5, { body: LINK }));
    for (const action of ["opened", "reopened", "ready_for_review", "synchronize"]) {
      expect((await deliver("pull_request", prEvent(action, { ...fresh }))).status).toBe(202);
      await deliver("pull_request", prEvent(action, { ...linked }));
    }
    await deliver("pull_request", prEvent("closed", { ...linked, state: "closed", merged: true, merged_by: { login: "carol" } }));
    await deliver("pull_request_review", {
      action: "submitted",
      review: { state: "approved", body: "ok", user: { login: "erin" }, html_url: `${linked.html_url}#review-1` },
      pull_request: { ...linked },
      repository: repoPayload(),
    });
    expect(errors).not.toHaveBeenCalled();
    expect(discordCalls(world)).toEqual([]);
    expect(world.threads).toHaveLength(0);
    expect(world.mutations().filter((c) => c.method === "PATCH")).toEqual([]);
    expect(fresh.body).toBe("Adds a u.FL.");
  });
});

describe("check_suite", () => {
  function suite(conclusion: string, pulls: number[], headSha: string, headBranch = "feature") {
    return {
      action: "completed",
      check_suite: {
        conclusion,
        head_sha: headSha,
        head_branch: headBranch,
        app: { name: "GitHub Actions" },
        pull_requests: pulls.map((number) => ({ number })),
      },
      repository: repoPayload(),
    };
  }

  it("posts nothing for a pull request's suite", async () => {
    const { world, deliver } = await harness();
    const pull = world.addPull("OpenRX", pullJson("OpenRX", 5, { body: LINK }));
    await deliver("check_suite", suite("failure", [5], pull.head.sha));
    await deliver("check_suite", suite("success", [5], pull.head.sha));
    expect(errors).not.toHaveBeenCalled();
    expect(discordCalls(world)).toEqual([]);
  });

  it("reports default-branch failures to the feed", async () => {
    const { world, deliver } = await harness();
    await deliver("check_suite", suite("failure", [], "c".repeat(40), "main"));
    await deliver("check_suite", suite("success", [], "c".repeat(40), "main"));
    await deliver("check_suite", suite("neutral", [], "c".repeat(40), "main"));
    await deliver("check_suite", suite("failure", [], "c".repeat(40), "other"));
    expect(errors).not.toHaveBeenCalled();
    expect(world.messagesIn(FEED).map((m) => FakeWorld.text(m))).toEqual([
      "**OpenRX** checks failed on `main` (GitHub Actions, [ccccccc](https://github.com/OpenDrone-hw/OpenRX/commit/cccccccccccccccccccccccccccccccccccccccc))",
    ]);
  });

  it("posts nothing for a private repository", async () => {
    const { world, deliver } = await harness();
    await deliver("check_suite", { ...suite("failure", [], "c".repeat(40), "main"), repository: repoPayload("OpenRX", { private: true }) });
    expect(discordCalls(world)).toEqual([]);
  });
});
