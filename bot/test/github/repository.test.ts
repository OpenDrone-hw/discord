import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { githubModule } from "../../src/github/index.ts";
import { previousTopics } from "../../src/github/repository.ts";
import type { Services } from "../../src/services.ts";
import { ANNOUNCEMENTS, FEED, FakeWorld, brokenD1, harness, repoPayload, sqliteD1 } from "./fakes.ts";

let errors: MockInstance;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function release(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: "v1.2.0",
    name: "OpenRX v1.2.0",
    body: "## Changes\n- Better antenna <!-- internal -->\n@everyone",
    html_url: "https://github.com/OpenDrone-hw/OpenRX/releases/tag/v1.2.0",
    prerelease: false,
    draft: false,
    author: { login: "carol" },
    assets: [
      { name: "OpenRX-gerbers.zip", browser_download_url: "https://github.com/OpenDrone-hw/OpenRX/releases/download/v1.2.0/OpenRX-gerbers.zip", size: 2_500_000 },
      { name: "evil.zip", browser_download_url: "https://evil.example/evil.zip", size: 1 },
    ],
    ...overrides,
  };
}

describe("release.published", () => {
  it("announces the release with asset links and posts a feed line", async () => {
    const { world, deliver } = await harness();
    await deliver("release", { action: "published", release: release(), repository: repoPayload() });
    expect(errors).not.toHaveBeenCalled();
    const [announcement] = world.messagesIn(ANNOUNCEMENTS);
    const text = FakeWorld.text(announcement);
    expect(text).toContain("## [OpenRX v1.2.0](https://github.com/OpenDrone-hw/OpenRX/releases/tag/v1.2.0)");
    expect(text).toContain("Release published by **carol**");
    expect(text).toContain("- Better antenna");
    expect(text).not.toContain("internal");
    expect(text).toContain("[OpenRX-gerbers.zip](https://github.com/OpenDrone-hw/OpenRX/releases/download/v1.2.0/OpenRX-gerbers.zip) (2.4 MB)");
    expect(text).toContain("- evil.zip (1 B)");
    expect(text).not.toContain("evil.example");
    expect(announcement?.allowed_mentions).toEqual({ parse: [] });
    expect(FakeWorld.text(world.messagesIn(FEED)[0])).toContain("**OpenRX** release [OpenRX v1.2.0]");
  });

  it("labels pre-releases, caps the asset list and skips drafts and private repositories", async () => {
    const { world, deliver } = await harness();
    const assets = Array.from({ length: 12 }, (_, i) => ({
      name: `a${i}.zip`,
      browser_download_url: `https://github.com/OpenDrone-hw/OpenRX/releases/download/v2.0.0-rc1/a${i}.zip`,
    }));
    await deliver("release", { action: "published", release: release({ prerelease: true, name: "", tag_name: "v2.0.0-rc1", assets }), repository: repoPayload() });
    await deliver("release", { action: "published", release: release({ draft: true }), repository: repoPayload() });
    await deliver("release", { action: "published", release: release(), repository: repoPayload("OpenRX", { private: true }) });
    const messages = world.messagesIn(ANNOUNCEMENTS);
    expect(messages).toHaveLength(1);
    const text = FakeWorld.text(messages[0]);
    expect(text).toContain("## [OpenRX v2.0.0-rc1]");
    expect(text).toContain("Pre-release published");
    expect(text).toContain("- and 2 more on GitHub");
    expect(text).not.toContain("a10.zip");
    expect(FakeWorld.text(world.messagesIn(FEED)[0])).toContain("pre-release");
  });

  it("is idempotent on redelivery", async () => {
    const { world, deliver } = await harness();
    const payload = { action: "published", release: release(), repository: repoPayload() };
    await deliver("release", payload, "r-1");
    await deliver("release", payload, "r-1");
    expect(world.messagesIn(ANNOUNCEMENTS)).toHaveLength(1);
    expect(world.messagesIn(FEED)).toHaveLength(1);
  });

  it("drops the post with a warning when #announcements is missing", async () => {
    const world = new FakeWorld();
    world.channels = world.channels.filter((c) => c.name !== "announcements");
    const { deliver } = await harness({ world });
    await deliver("release", { action: "published", release: release(), repository: repoPayload() });
    expect(errors).not.toHaveBeenCalled();
    expect(world.messagesIn(FEED)).toHaveLength(1);
  });
});

describe("repository.edited", () => {
  function edited(from: string[] | null | undefined, to: string[], extra: Record<string, unknown> = {}) {
    const changes = from === undefined ? { description: { from: "old" } } : { topics: { from } };
    return { action: "edited", changes, repository: repoPayload("OpenRX", { topics: to, ...extra }) };
  }

  it("reads changes.topics.from", () => {
    expect(previousTopics({ changes: { topics: { from: ["a", 1, "status-beta"] } } })).toEqual(["a", "status-beta"]);
    expect(previousTopics({ changes: { topics: { from: null } } })).toEqual([]);
    expect(previousTopics({ changes: { description: { from: "x" } } })).toBeNull();
    expect(previousTopics({})).toBeNull();
  });

  it("announces a lifecycle move", async () => {
    const { world, deliver } = await harness();
    await deliver("repository", edited(["kicad", "status-alpha"], ["kicad", "status-beta"]));
    expect(errors).not.toHaveBeenCalled();
    expect(FakeWorld.text(world.messagesIn(ANNOUNCEMENTS)[0])).toBe(
      "### [OpenRX](https://github.com/OpenDrone-hw/OpenRX) moved from **alpha** to **beta**",
    );
    expect(FakeWorld.text(world.messagesIn(FEED)[0])).toContain("moved from **alpha** to **beta**");
  });

  it("announces a first status and uses the most advanced one", async () => {
    const { world, deliver } = await harness();
    await deliver("repository", edited(null, ["status-planned", "status-launched"]));
    expect(FakeWorld.text(world.messagesIn(ANNOUNCEMENTS)[0])).toContain("is now **launched**");
  });

  it("ignores other topic changes, a removed status, other edits and private repositories", async () => {
    const { world, deliver } = await harness();
    await deliver("repository", edited(["status-beta"], ["status-beta", "kicad"]));
    await deliver("repository", edited(["status-beta"], []));
    await deliver("repository", edited(undefined, ["status-launched"]));
    await deliver("repository", edited(["status-beta"], ["status-launched"], { private: true }));
    expect(world.discordPosts()).toEqual([]);
  });
});

describe("push", () => {
  function push(overrides: Record<string, unknown> = {}) {
    return {
      ref: "refs/heads/main",
      before: "1".repeat(40),
      after: "abcdef1234567890abcdef1234567890abcdef12",
      deleted: false,
      compare: "https://github.com/OpenDrone-hw/OpenRX/compare/1111111...abcdef1",
      commits: [{ id: "a" }, { id: "b" }],
      head_commit: { id: "abcdef1", message: "Update the BOM *now*\n\nLonger text" },
      repository: repoPayload(),
      sender: { login: "bob" },
      ...overrides,
    };
  }

  it("posts pushes to the default branch to the feed", async () => {
    const { world, deliver } = await harness();
    await deliver("push", push());
    expect(errors).not.toHaveBeenCalled();
    expect(FakeWorld.text(world.messagesIn(FEED)[0])).toBe(
      "**OpenRX** bob pushed 2 commits to `main`: [Update the BOM \\*now\\*](https://github.com/OpenDrone-hw/OpenRX/compare/1111111...abcdef1)",
    );
  });

  it("skips other branches, tags, deletions, empty pushes, PR merges and private repositories", async () => {
    const { world, deliver } = await harness();
    await deliver("push", push({ ref: "refs/heads/feature" }));
    await deliver("push", push({ ref: "refs/tags/v1.0.0" }));
    await deliver("push", push({ deleted: true, after: "0".repeat(40) }));
    await deliver("push", push({ commits: [] }));
    await deliver("push", push({ head_commit: { message: "Merge pull request #12 from alice/feature\n\nMove antenna" } }));
    await deliver("push", push({ head_commit: { message: "Move antenna (#12)" } }));
    await deliver("push", push({ repository: repoPayload("OpenRX", { private: true }) }));
    expect(world.discordPosts()).toEqual([]);
  });

  it("does not need the GitHub App secrets", async () => {
    const h = await harness();
    Object.defineProperty(h.services, "github", {
      get() {
        throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set");
      },
    });
    await h.deliver("push", push());
    expect(errors).not.toHaveBeenCalled();
    expect(h.world.messagesIn(FEED)).toHaveLength(1);
  });

  it("names a single commit and uses the repository's default branch", async () => {
    const { world, deliver } = await harness();
    await deliver("push", push({ ref: "refs/heads/master", commits: [{ id: "a" }], repository: repoPayload("OpenRX", { default_branch: "master" }) }));
    expect(FakeWorld.text(world.messagesIn(FEED)[0])).toContain("pushed 1 commit to `master`");
  });
});

describe("scheduled", () => {
  it("prunes old delivery rows and survives a broken D1", async () => {
    const db = sqliteD1();
    const { services, deliver } = await harness({ db });
    await deliver("push", {
      ref: "refs/heads/main",
      after: "a".repeat(40),
      commits: [{}],
      head_commit: { message: "x" },
      repository: repoPayload(),
    });
    db.sqlite.prepare("UPDATE github_deliveries SET updated_at = 0").run();
    await githubModule.scheduled!({} as ScheduledController, services);
    expect(db.sqlite.prepare("SELECT count(*) AS n FROM github_deliveries").get()).toEqual({ n: 0 });

    const broken: Services = { ...services, env: { ...services.env, DB: brokenD1() } };
    await githubModule.scheduled!({} as ScheduledController, broken);
    expect(String(errors.mock.calls[0]?.[0])).toContain("prune failed");
  });
});
