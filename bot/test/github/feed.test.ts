import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config, feedModeFor, parseConfig } from "../../src/config.ts";
import raw from "../../config/repos.json" with { type: "json" };
import { CHANNEL_RX, FEED, FakeWorld, harness, pullJson, repoPayload, sqliteD1 } from "./fakes.ts";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const SHA = "abcdef1234567890abcdef1234567890abcdef12";

function push(overrides: Record<string, unknown> = {}) {
  return {
    ref: "refs/heads/main",
    after: SHA,
    commits: [{ id: SHA }],
    head_commit: { id: SHA, message: "Move antenna (#12)\n\nLonger text", url: `https://github.com/OpenDrone-hw/OpenRX/commit/${SHA}` },
    repository: repoPayload(),
    sender: { login: "bob" },
    ...overrides,
  };
}

const release = {
  tag_name: "v1.2.0",
  name: "OpenRX v1.2.0",
  body: "notes",
  html_url: "https://github.com/OpenDrone-hw/OpenRX/releases/tag/v1.2.0",
  author: { login: "carol" },
  assets: [],
};

describe("shipped config", () => {
  it("is deploys only, with no repository override", () => {
    expect(config.feed).toBe("deploys");
    expect(Object.values(config.repos).filter((r) => r.feed !== undefined)).toEqual([]);
    expect(feedModeFor("OpenDrone-hw/OpenDrone-Web")).toBe("deploys");
  });

  it("accepts a per-repository full override and rejects bad values", () => {
    const withFull = JSON.parse(JSON.stringify(raw)) as { repos: Record<string, Record<string, unknown>> };
    (withFull.repos["OpenRX"] as Record<string, unknown>).feed = "full";
    const parsed = parseConfig(withFull);
    expect(feedModeFor("OpenRX", parsed)).toBe("full");
    expect(feedModeFor("OpenFC", parsed)).toBe("deploys");

    (withFull.repos["OpenRX"] as Record<string, unknown>).feed = "all";
    expect(() => parseConfig(withFull)).toThrow(/repos.OpenRX.feed/);
    const noFeed = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
    delete noFeed.feed;
    expect(() => parseConfig(noFeed)).toThrow(/feed/);
  });
});

describe("feed deploys", () => {
  it("posts nothing for a PR opened, and records the delivery as skipped", async () => {
    const db = sqliteD1();
    const h = await harness({ feed: "deploys", db });
    h.world.addPull("OpenRX", pullJson("OpenRX", 5));
    const response = await h.deliver("pull_request", { action: "opened", pull_request: pullJson("OpenRX", 5), repository: repoPayload() }, "d-pr");
    expect(response.status).toBe(202);
    expect(h.world.discordPosts()).toEqual([]);
    expect(db.sqlite.prepare("SELECT key, state FROM github_deliveries").all()).toEqual([{ key: "d-pr:skipped", state: "skipped" }]);
  });

  it("posts nothing for reviews, checks, issues and comments, repository edits", async () => {
    const h = await harness({ feed: "deploys" });
    const issue = { number: 7, title: "t", body: "b", html_url: "https://github.com/OpenDrone-hw/OpenRX/issues/7", user: { login: "dave", type: "User" }, state: "open" };
    await h.deliver("issues", { action: "opened", issue, repository: repoPayload() });
    await h.deliver("issue_comment", { action: "created", issue, comment: { body: "hi", user: { login: "erin", type: "User" } }, repository: repoPayload() });
    await h.deliver("repository", { action: "edited", changes: { topics: { from: ["status-alpha"] } }, repository: repoPayload("OpenRX", { topics: ["status-beta"] }) });
    await h.deliver("check_suite", { action: "completed", check_suite: { conclusion: "failure", head_branch: "main", head_sha: SHA }, repository: repoPayload() });
    expect(h.world.discordPosts()).toEqual([]);
  });

  it("posts one line to git-feed for a push to main, merges included", async () => {
    const { world, deliver } = await harness({ feed: "deploys" });
    await deliver("push", push());
    expect(world.discordPosts()).toHaveLength(1);
    expect(world.messagesIn(CHANNEL_RX)).toEqual([]);
    expect(FakeWorld.text(world.messagesIn(FEED)[0])).toBe(
      `**OpenRX** \`abcdef1\` [Move antenna (#12)](https://github.com/OpenDrone-hw/OpenRX/commit/${SHA})`,
    );
  });

  it("skips other branches, tags, deletions, empty pushes and private repositories", async () => {
    const { world, deliver } = await harness({ feed: "deploys" });
    await deliver("push", push({ ref: "refs/heads/feature" }));
    await deliver("push", push({ ref: "refs/tags/v1.0.0" }));
    await deliver("push", push({ deleted: true, after: "0".repeat(40) }));
    await deliver("push", push({ commits: [] }));
    await deliver("push", push({ repository: repoPayload("OpenRX", { private: true }) }));
    expect(world.discordPosts()).toEqual([]);
  });

  it("posts one line for a published release and none for a draft", async () => {
    const { world, deliver } = await harness({ feed: "deploys" });
    await deliver("release", { action: "published", release, repository: repoPayload() });
    await deliver("release", { action: "published", release: { ...release, draft: true }, repository: repoPayload() });
    expect(world.discordPosts()).toHaveLength(1);
    expect(world.messagesIn(CHANNEL_RX)).toEqual([]);
    const text = FakeWorld.text(world.messagesIn(FEED)[0]);
    expect(text).toContain("**OpenRX**");
    expect(text).toContain("v1.2.0");
    expect(text).toContain("https://github.com/OpenDrone-hw/OpenRX/releases/tag/v1.2.0");
  });

  it("is idempotent per delivery", async () => {
    const { world, deliver } = await harness({ feed: "deploys" });
    await deliver("push", push(), "same");
    await deliver("push", push(), "same");
    expect(world.messagesIn(FEED)).toHaveLength(1);
  });

  it("still answers a collision on GitHub only", async () => {
    const h = await harness({ feed: "deploys" });
    h.world.addPull("OpenRX", pullJson("OpenRX", 5));
    await h.deliver("pull_request", { action: "opened", pull_request: pullJson("OpenRX", 5), repository: repoPayload() });
    expect(h.world.discordPosts()).toEqual([]);
  });
});

describe("feed full override", () => {
  it("restores PR threads, product channel lines and the PR-merge filter for that repository only", async () => {
    const h = await harness({ feed: "deploys", repoFeed: { OpenRX: "full" } });
    h.world.addPull("OpenRX", pullJson("OpenRX", 5));
    await h.deliver("pull_request", { action: "opened", pull_request: pullJson("OpenRX", 5), repository: repoPayload() });
    expect(h.world.discordPosts().length).toBeGreaterThan(0);
    const before = h.world.discordPosts().length;
    await h.deliver("push", push({ head_commit: { message: "Move antenna (#12)" } }));
    expect(h.world.discordPosts()).toHaveLength(before);
    await h.deliver("push", push({ commits: [{}, {}], head_commit: { message: "Update the BOM" }, compare: "https://github.com/OpenDrone-hw/OpenRX/compare/1111111...abcdef1" }));
    expect(FakeWorld.text(h.world.messagesIn(FEED).at(-1) as never)).toContain("pushed 2 commits to `main`");
  });
});
