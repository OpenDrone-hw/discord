import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { githubModule } from "../../src/github/index.ts";
import { Registry } from "../../src/registry.ts";
import {
  ANNOUNCEMENTS,
  EXISTING_THREAD,
  FC_THREAD,
  OTHER_FORUM_THREAD,
  RULES,
  FEED,
  FORUM_RX,
  FakeWorld,
  GUILD,
  TAG_BETA,
  TAG_RX,
  harness,
  pullJson,
  repoPayload,
} from "./fakes.ts";

const LINK = `Discussion: https://discord.com/channels/${GUILD}/${EXISTING_THREAD}`;

let errors: MockInstance;
let warnings: MockInstance;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function expectNoErrors() {
  expect(errors.mock.calls.map((c) => c.map(String).join(" "))).toEqual([]);
}

function prEvent(action: string, pull: object, extra: Record<string, unknown> = {}) {
  return { action, number: (pull as { number: number }).number, pull_request: pull, repository: repoPayload(), ...extra };
}

describe("module registration", () => {
  it("registers the handled events and actions", () => {
    const registry = new Registry([githubModule]);
    const names = (event: string, action?: string) => registry.githubHandlers(event, action).length;
    for (const action of ["opened", "reopened", "ready_for_review", "synchronize", "closed"]) {
      expect(names("pull_request", action)).toBe(1);
    }
    expect(names("pull_request", "edited")).toBe(0);
    expect(names("pull_request", "labeled")).toBe(0);
    expect(names("pull_request_review", "submitted")).toBe(1);
    expect(names("pull_request_review", "dismissed")).toBe(0);
    expect(names("check_suite", "completed")).toBe(1);
    expect(names("check_suite", "requested")).toBe(0);
    expect(names("release", "published")).toBe(1);
    expect(names("release", "created")).toBe(0);
    expect(names("repository", "edited")).toBe(1);
    expect(names("push", undefined)).toBe(1);
  });
});

describe("pull_request opened", () => {
  it("creates a tagged forum post, links it in the PR body and posts to #git-feed", async () => {
    const { world, deliver } = await harness();
    const pull = world.addPull("OpenRX", pullJson("OpenRX", 12, { title: "Move the **antenna** <@&1>", body: "Adds a u.FL.\n<!-- hidden -->" }));

    const response = await deliver("pull_request", prEvent("opened", { ...pull }));
    expect(response.status).toBe(202);
    expectNoErrors();

    expect(world.threads).toHaveLength(1);
    const thread = world.threads[0]!;
    expect(thread.forumId).toBe(FORUM_RX);
    expect(thread.body.name).toBe("OpenRX #12: Move the **antenna** <@&1>");
    expect(thread.body.applied_tags).toEqual([TAG_RX, TAG_BETA]);
    expect(decodeURIComponent(thread.reason ?? "")).toBe("GitHub OpenDrone-hw/OpenRX#12");
    const starter = thread.body.message as Record<string, unknown>;
    expect(starter.flags).toBe(1 << 15);
    expect(starter.allowed_mentions).toEqual({ parse: [] });
    const text = FakeWorld.text(starter);
    expect(text).toContain("[OpenRX #12: Move the \\*\\*antenna\\*\\* \\<@&1\\>](https://github.com/OpenDrone-hw/OpenRX/pull/12)");
    expect(text).toContain("**alice** opened this pull request: `feature-12` into `main`");
    expect(text).toContain("Adds a u.FL.");
    expect(text).not.toContain("hidden");
    expect(text).toContain("-# 3 files changed, +10 -2");

    // The starter message is the card: nothing else goes into the new thread.
    expect(world.messagesIn(thread.id)).toHaveLength(1);
    expect(pull.body).toBe(`Adds a u.FL.\n<!-- hidden -->\n\nDiscussion: https://discord.com/channels/${GUILD}/${thread.id}`);

    const feed = world.messagesIn(FEED);
    expect(feed).toHaveLength(1);
    expect(FakeWorld.text(feed[0])).toBe(
      "**OpenRX** #12 opened by alice: [Move the \\*\\*antenna\\*\\* \\<@&1\\>](https://github.com/OpenDrone-hw/OpenRX/pull/12)",
    );
    for (const call of world.discordPosts()) {
      const body = call.body as Record<string, unknown>;
      const message = (body.message as Record<string, unknown> | undefined) ?? body;
      expect(message.allowed_mentions).toEqual({ parse: [] });
    }
  });

  it("posts into the linked thread instead of creating one", async () => {
    const { world, deliver } = await harness();
    const pull = world.addPull("OpenRX", pullJson("OpenRX", 3, { body: `Text\n\n${LINK}` }));
    await deliver("pull_request", prEvent("opened", { ...pull }));
    expectNoErrors();
    expect(world.threads).toHaveLength(0);
    expect(world.messagesIn(EXISTING_THREAD)).toHaveLength(1);
    expect(FakeWorld.text(world.messagesIn(EXISTING_THREAD)[0])).toContain("opened this pull request");
    expect(world.mutations().some((c) => c.method === "PATCH")).toBe(false);
  });

  it("marks drafts and uses the draft wording in the feed", async () => {
    const { world, deliver } = await harness();
    const pull = world.addPull("OpenRX", pullJson("OpenRX", 4, { draft: true }));
    await deliver("pull_request", prEvent("opened", { ...pull }));
    expect(FakeWorld.text(world.threads[0]?.body.message as Record<string, unknown>)).toContain("opened a draft pull request");
    expect(FakeWorld.text(world.messagesIn(FEED)[0])).toContain("#4 opened a draft by alice");
  });

  it("does nothing twice when GitHub redelivers the same delivery", async () => {
    const { world, deliver } = await harness();
    const pull = world.addPull("OpenRX", pullJson("OpenRX", 12));
    const payload = prEvent("opened", { ...pull });
    await deliver("pull_request", payload, "same-guid");
    const before = world.mutations().length;
    await deliver("pull_request", payload, "same-guid");
    expectNoErrors();
    expect(world.threads).toHaveLength(1);
    expect(world.messagesIn(FEED)).toHaveLength(1);
    expect(world.mutations()).toHaveLength(before);
  });

  it("reads the PR again before creating a thread, so a stale payload does not duplicate it", async () => {
    const { world, deliver } = await harness();
    const pull = world.addPull("OpenRX", pullJson("OpenRX", 12));
    const stale = prEvent("opened", { ...pull });
    await deliver("pull_request", stale);
    // Same event under a new delivery id (for example a manual re-send): the payload body has no line.
    await deliver("pull_request", stale);
    expect(world.threads).toHaveLength(1);
    expect(world.messagesIn(world.threads[0]!.id)).toHaveLength(2);
  });

  it("retries only the failed step on redelivery", async () => {
    const { world, deliver } = await harness();
    const pull = world.addPull("OpenRX", pullJson("OpenRX", 12));
    world.failing.add(`POST /api/v10/channels/${FEED}/messages`);
    const payload = prEvent("opened", { ...pull });
    await deliver("pull_request", payload, "guid-1");
    expect(errors).toHaveBeenCalledOnce();
    expect(world.threads).toHaveLength(1);
    expect(world.messagesIn(FEED)).toHaveLength(0);

    world.failing.clear();
    await deliver("pull_request", payload, "guid-1");
    expect(world.threads).toHaveLength(1);
    expect(world.messagesIn(FEED)).toHaveLength(1);
  });

  it("keeps a body edit made while the thread was being created", async () => {
    const { world, deliver } = await harness();
    const pull = world.addPull("OpenRX", pullJson("OpenRX", 12, { body: "old" }));
    const payload = prEvent("opened", { ...pull });
    pull.body = "edited by the author";
    await deliver("pull_request", payload);
    expect(pull.body).toBe(`edited by the author\n\nDiscussion: https://discord.com/channels/${GUILD}/${world.threads[0]!.id}`);
  });

  it("posts only to #git-feed for an org repository missing from repos.json", async () => {
    const { world, deliver } = await harness();
    const pull = pullJson("Sandbox", 1);
    world.addPull("Sandbox", pull);
    await deliver("pull_request", { ...prEvent("opened", pull), repository: repoPayload("Sandbox") });
    expectNoErrors();
    expect(world.threads).toHaveLength(0);
    expect(world.messagesIn(FEED)).toHaveLength(1);
  });

  it("ignores private repositories and repositories outside the organisation", async () => {
    const { world, deliver } = await harness();
    const pull = world.addPull("OpenRX", pullJson("OpenRX", 12));
    await deliver("pull_request", { ...prEvent("opened", pull), repository: repoPayload("OpenRX", { private: true }) });
    await deliver("pull_request", {
      ...prEvent("opened", pull),
      repository: { ...repoPayload("OpenRX"), full_name: "someone/OpenRX", owner: { login: "someone" } },
    });
    const noFlag = repoPayload("OpenRX");
    delete noFlag.private;
    await deliver("pull_request", { ...prEvent("opened", pull), repository: noFlag });
    expectNoErrors();
    expect(world.discordPosts()).toEqual([]);
    expect(world.mutations().filter((c) => c.method === "PATCH")).toEqual([]);
  });

  it("logs and continues when the forum lacks the product tag", async () => {
    const world = new FakeWorld();
    world.channels[0]!.available_tags = [];
    const { deliver } = await harness({ world });
    const pull = world.addPull("OpenRX", pullJson("OpenRX", 12));
    await deliver("pull_request", prEvent("opened", { ...pull }));
    expectNoErrors();
    expect(world.threads[0]?.body.applied_tags).toEqual([]);
    expect(String(warnings.mock.calls[0]?.[0])).toContain("has no tag OpenRX");
  });

  it("reports a missing forum as an error but still posts the feed line", async () => {
    const world = new FakeWorld();
    world.channels = world.channels.slice(1);
    const { deliver } = await harness({ world });
    const pull = world.addPull("OpenRX", pullJson("OpenRX", 12));
    await deliver("pull_request", prEvent("opened", { ...pull }));
    expect(String(errors.mock.calls[0]?.[1])).toContain("forum receivers for OpenRX does not exist");
    expect(world.messagesIn(FEED)).toHaveLength(1);
  });
});

describe("pull_request other actions", () => {
  it("posts a compact push line on synchronize without a feed line", async () => {
    const { world, deliver } = await harness();
    const pull = world.addPull("OpenRX", pullJson("OpenRX", 5, { body: LINK }));
    await deliver("pull_request", prEvent("synchronize", { ...pull }, { after: "0123456789abcdef", sender: { login: "bob" } }));
    expectNoErrors();
    const messages = world.messagesIn(EXISTING_THREAD);
    expect(messages).toHaveLength(1);
    expect(FakeWorld.text(messages[0])).toContain("**bob** pushed `0123456` to `feature-5`");
    expect(FakeWorld.text(messages[0])).not.toContain("files changed");
    expect(world.messagesIn(FEED)).toHaveLength(0);
  });

  it("creates the thread for an older PR on its first push, with the PR as the starter", async () => {
    const { world, deliver } = await harness();
    const pull = world.addPull("OpenRX", pullJson("OpenRX", 6));
    await deliver("pull_request", prEvent("synchronize", { ...pull }, { after: "fedcba9876543210" }));
    expect(world.threads).toHaveLength(1);
    const messages = world.messagesIn(world.threads[0]!.id);
    expect(messages).toHaveLength(2);
    expect(FakeWorld.text(messages[0])).toContain("opened this pull request");
    expect(FakeWorld.text(messages[1])).toContain("pushed `fedcba9`");
  });

  it("announces a merge in the thread and the feed", async () => {
    const { world, deliver } = await harness();
    const pull = world.addPull(
      "OpenRX",
      pullJson("OpenRX", 7, { body: LINK, state: "closed", merged: true, merged_by: { login: "carol" } }),
    );
    await deliver("pull_request", prEvent("closed", { ...pull }));
    expectNoErrors();
    const card = world.messagesIn(EXISTING_THREAD)[0];
    expect(FakeWorld.text(card)).toContain("**carol** merged this pull request into `main`");
    expect((card?.components as Array<{ accent_color: number }>)[0]?.accent_color).toBe(0x8250df);
    expect(FakeWorld.text(world.messagesIn(FEED)[0])).toContain("#7 merged by carol");
  });

  it("reports a close without merge and never creates a thread for a closed PR", async () => {
    const { world, deliver } = await harness();
    const pull = world.addPull("OpenRX", pullJson("OpenRX", 8, { state: "closed" }));
    await deliver("pull_request", prEvent("closed", { ...pull }, { sender: { login: "dave" } }));
    expectNoErrors();
    expect(world.threads).toHaveLength(0);
    expect(FakeWorld.text(world.messagesIn(FEED)[0])).toContain("#8 closed by dave");
  });

  it("skips a linked thread that was deleted", async () => {
    const world = new FakeWorld();
    world.goneThreads.add(EXISTING_THREAD);
    const { deliver } = await harness({ world });
    const pull = world.addPull("OpenRX", pullJson("OpenRX", 9, { body: LINK }));
    await deliver("pull_request", prEvent("ready_for_review", { ...pull }));
    expectNoErrors();
    expect(world.threads).toHaveLength(0);
    expect(String(warnings.mock.calls[0]?.[0])).toContain("is not a thread in #receivers");
    expect(world.discordPosts().filter((c) => c.url.includes(EXISTING_THREAD))).toHaveLength(0);
    expect(FakeWorld.text(world.messagesIn(FEED)[0])).toContain("marked ready for review");
  });
});

describe("pull_request_review", () => {
  function review(state: string, body = "", user = "erin") {
    return { state, body, user: { login: user }, html_url: "https://github.com/OpenDrone-hw/OpenRX/pull/5#pullrequestreview-1" };
  }

  it("posts approvals to the thread and the feed", async () => {
    const { world, deliver } = await harness();
    const pull = world.addPull("OpenRX", pullJson("OpenRX", 5, { body: LINK }));
    await deliver("pull_request_review", {
      action: "submitted",
      review: review("approved", "Looks good, see [notes](https://evil.example)"),
      pull_request: { ...pull },
      repository: repoPayload(),
    });
    expectNoErrors();
    const text = FakeWorld.text(world.messagesIn(EXISTING_THREAD)[0]);
    expect(text).toContain("**erin** approved these changes");
    expect(text).toContain("notes (https://evil.example)");
    expect(FakeWorld.text(world.messagesIn(FEED)[0])).toContain("#5 approved by erin");
  });

  it("posts requested changes and skips empty comment reviews", async () => {
    const { world, deliver } = await harness();
    const pull = world.addPull("OpenRX", pullJson("OpenRX", 5, { body: LINK }));
    await deliver("pull_request_review", { action: "submitted", review: review("CHANGES_REQUESTED", "Fix the footprint"), pull_request: { ...pull }, repository: repoPayload() });
    await deliver("pull_request_review", { action: "submitted", review: review("commented"), pull_request: { ...pull }, repository: repoPayload() });
    await deliver("pull_request_review", { action: "submitted", review: review("commented", "nit: rename"), pull_request: { ...pull }, repository: repoPayload() });
    expectNoErrors();
    const texts = world.messagesIn(EXISTING_THREAD).map((m) => FakeWorld.text(m));
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("requested changes");
    expect(texts[1]).toContain("**erin** reviewed");
    expect(world.messagesIn(FEED).map((m) => FakeWorld.text(m))).toEqual([
      expect.stringContaining("#5 changes requested by erin"),
    ]);
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

  it("posts results for the PR head into linked threads only", async () => {
    const { world, deliver } = await harness();
    const linked = world.addPull("OpenRX", pullJson("OpenRX", 5, { body: LINK }));
    world.addPull("OpenRX", pullJson("OpenRX", 6));
    await deliver("check_suite", suite("failure", [5, 6], linked.head.sha));
    expectNoErrors();
    const messages = world.messagesIn(EXISTING_THREAD);
    expect(messages).toHaveLength(1);
    expect(FakeWorld.text(messages[0])).toContain("Checks failed (GitHub Actions) on `aaaaaaa`");
    expect(world.threads).toHaveLength(0);
    expect(world.messagesIn(FEED)).toHaveLength(0);
  });

  it("looks up the installation when the payload has none", async () => {
    const { world, deliver } = await harness();
    const pull = world.addPull("OpenRX", pullJson("OpenRX", 5, { body: LINK }));
    await deliver("check_suite", { ...suite("success", [5], pull.head.sha), installation: null });
    expectNoErrors();
    const paths = world.calls.filter((c) => c.url.startsWith("https://api.github.com/")).map((c) => new URL(c.url).pathname);
    expect(paths.slice(0, 3)).toEqual([
      "/repos/OpenDrone-hw/OpenRX/installation",
      "/app/installations/99/access_tokens",
      "/repos/OpenDrone-hw/OpenRX/pulls/5",
    ]);
    expect(world.messagesIn(EXISTING_THREAD)).toHaveLength(1);
  });

  it("skips stale suites and unreported conclusions", async () => {
    const { world, deliver } = await harness();
    const pull = world.addPull("OpenRX", pullJson("OpenRX", 5, { body: LINK }));
    await deliver("check_suite", suite("success", [5], "b".repeat(40)));
    await deliver("check_suite", suite("neutral", [5], pull.head.sha));
    await deliver("check_suite", suite("cancelled", [5], pull.head.sha));
    await deliver("check_suite", suite("success", [5], pull.head.sha));
    expectNoErrors();
    expect(world.messagesIn(EXISTING_THREAD).map((m) => FakeWorld.text(m))).toEqual([
      expect.stringContaining("Checks passed"),
    ]);
  });

  it("reports default-branch failures to the feed", async () => {
    const { world, deliver } = await harness();
    await deliver("check_suite", suite("failure", [], "c".repeat(40), "main"));
    await deliver("check_suite", suite("success", [], "c".repeat(40), "main"));
    await deliver("check_suite", suite("failure", [], "c".repeat(40), "other"));
    expectNoErrors();
    expect(world.messagesIn(FEED).map((m) => FakeWorld.text(m))).toEqual([
      "**OpenRX** checks failed on `main` (GitHub Actions, [ccccccc](https://github.com/OpenDrone-hw/OpenRX/commit/cccccccccccccccccccccccccccccccccccccccc))",
    ]);
  });
});

describe("Discussion lines that do not point at this repository's forum", () => {
  const targets: Array<[string, string]> = [
    ["a text channel (#rules)", RULES],
    ["an announcement channel", ANNOUNCEMENTS],
    ["a thread in a forum outside repos.json (#web-support)", OTHER_FORUM_THREAD],
    ["a thread in another repository's forum", FC_THREAD],
    ["a channel that does not exist", "1600000000000077777"],
  ];
  const linkTo = (id: string) => `Discussion: https://discord.com/channels/${GUILD}/${id}`;

  for (const [label, target] of targets) {
    it(`posts nothing for ${label} and creates no second post`, async () => {
      const { world, deliver } = await harness();
      const pull = world.addPull("OpenRX", pullJson("OpenRX", 21, { body: `Change.\n\n${linkTo(target)}` }));
      const before = pull.body;
      await deliver("pull_request", prEvent("opened", { ...pull }));
      await deliver("pull_request", prEvent("synchronize", { ...pull }, { after: "b".repeat(40) }));
      await deliver("pull_request_review", {
        action: "submitted",
        review: { state: "APPROVED", body: "ok", user: { login: "erin" }, html_url: `${pull.html_url}#review-1` },
        pull_request: { ...pull },
        repository: repoPayload(),
      });
      await deliver("check_suite", {
        action: "completed",
        check_suite: {
          conclusion: "failure",
          head_sha: pull.head.sha,
          head_branch: "feature",
          app: { name: "GitHub Actions" },
          pull_requests: [{ number: 21 }],
        },
        repository: repoPayload(),
      });
      expectNoErrors();
      expect(world.threads).toHaveLength(0);
      const posted = world.discordPosts().map((c) => c.url);
      expect(posted.every((url) => url.endsWith(`/channels/${FEED}/messages`))).toBe(true);
      expect(posted).toHaveLength(2);
      expect(world.pull("OpenRX", 21).body).toBe(before);
      expect(warnings.mock.calls.map((c) => String(c[0])).some((w) => w.includes(`points at ${target}`))).toBe(true);
    });
  }

  it("reads each linked channel from Discord once per isolate", async () => {
    const { world, deliver } = await harness();
    const pull = world.addPull("OpenRX", pullJson("OpenRX", 22, { body: LINK }));
    await deliver("pull_request", prEvent("synchronize", { ...pull }));
    await deliver("pull_request", prEvent("synchronize", { ...pull }));
    expectNoErrors();
    expect(world.messagesIn(EXISTING_THREAD)).toHaveLength(2);
    expect(world.calls.filter((c) => c.method === "GET" && c.url.endsWith(`/channels/${EXISTING_THREAD}`))).toHaveLength(1);
  });
});
