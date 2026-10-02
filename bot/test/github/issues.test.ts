import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { githubModule } from "../../src/github/index.ts";
import { issueStoreFor, issueThreadName } from "../../src/github/issues.ts";
import { ANNOUNCEMENTS, CHANNEL_RX, FEED, FakeWorld, harness, repoPayload, sqliteD1 } from "./fakes.ts";

let errors: MockInstance;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function issue(number = 7, overrides: Record<string, unknown> = {}) {
  return {
    number,
    title: "UART2 pads swapped on rev B",
    body: "<!-- template -->\nTX and RX are swapped on the **UART2** pads. @everyone\n\nSecond paragraph.",
    html_url: `https://github.com/OpenDrone-hw/OpenRX/issues/${number}`,
    user: { login: "dave", type: "User" },
    state: "open",
    ...overrides,
  };
}

function comment(overrides: Record<string, unknown> = {}) {
  return {
    body: "Same here on my <@123> board, see [photo](https://example.com/p.jpg)",
    html_url: "https://github.com/OpenDrone-hw/OpenRX/issues/7#issuecomment-1",
    user: { login: "erin", type: "User" },
    author_association: "NONE",
    ...overrides,
  };
}

describe("issues", () => {
  it("opened: starts a thread in the product channel with an issue card and posts a feed line", async () => {
    const { world, deliver } = await harness();
    await deliver("issues", { action: "opened", issue: issue(), repository: repoPayload() });
    expect(errors).not.toHaveBeenCalled();
    expect(world.threads).toHaveLength(1);
    const thread = world.threads[0]!;
    expect(thread.channelId).toBe(CHANNEL_RX);
    expect(thread.body).toEqual({ name: "OpenRX issue #7: UART2 pads swapped on rev B", auto_archive_duration: 10080 });
    expect(FakeWorld.text(world.messagesIn(CHANNEL_RX)[0])).toBe(
      "Issue **OpenRX** #7 by dave: [UART2 pads swapped on rev B](https://github.com/OpenDrone-hw/OpenRX/issues/7)",
    );
    const card = world.messagesIn(thread.id)[0];
    const text = FakeWorld.text(card);
    expect(text).toContain("### [OpenRX issue #7: UART2 pads swapped on rev B](https://github.com/OpenDrone-hw/OpenRX/issues/7)");
    expect(text).toContain("**dave** opened this issue");
    expect(text).toContain("TX and RX are swapped on the **UART2** pads.");
    expect(text).not.toContain("Second paragraph");
    expect(card?.allowed_mentions).toEqual({ parse: [] });
    expect(FakeWorld.text(world.messagesIn(FEED)[0])).toContain("**OpenRX** issue #7 opened by dave");
    expect(world.messagesIn(ANNOUNCEMENTS)).toEqual([]);
  });

  it("cuts the thread name to Discord's 100 characters", () => {
    const name = issueThreadName("OpenRX-Lite-UFL", { number: 1234, title: "x".repeat(200) });
    expect(name).toHaveLength(100);
    expect(name.startsWith("OpenRX-Lite-UFL issue #1234: xxx")).toBe(true);
    expect(name.endsWith("...")).toBe(true);
  });

  it("is idempotent on redelivery", async () => {
    const { world, deliver } = await harness();
    const payload = { action: "opened", issue: issue(), repository: repoPayload() };
    await deliver("issues", payload, "i-1");
    await deliver("issues", payload, "i-1");
    expect(world.threads).toHaveLength(1);
    expect(world.messagesIn(world.threads[0]!.id)).toHaveLength(1);
    expect(world.messagesIn(FEED)).toHaveLength(1);
  });

  it("issue_comment.created: one line in the thread; bot comments post nothing", async () => {
    const { world, deliver } = await harness();
    await deliver("issues", { action: "opened", issue: issue(), repository: repoPayload() });
    const threadId = world.threads[0]!.id;
    await deliver("issue_comment", { action: "created", issue: issue(), comment: comment(), repository: repoPayload() });
    await deliver("issue_comment", {
      action: "created",
      issue: issue(),
      comment: comment({ user: { login: "dependabot[bot]", type: "Bot" } }),
      repository: repoPayload(),
    });
    expect(errors).not.toHaveBeenCalled();
    const messages = world.messagesIn(threadId);
    expect(messages).toHaveLength(2);
    const line = FakeWorld.text(messages[1]);
    expect(line).toBe(
      "**erin** [commented](https://github.com/OpenDrone-hw/OpenRX/issues/7#issuecomment-1): Same here on my \\<@123\\> board, see photo (https://example.com/p.jpg)",
    );
    expect(messages[1]?.allowed_mentions).toEqual({ parse: [] });
    // Comments are not in the feed.
    expect(world.messagesIn(FEED)).toHaveLength(1);
  });

  it("cuts a long comment to 300 characters", async () => {
    const { world, deliver } = await harness();
    await deliver("issues", { action: "opened", issue: issue(), repository: repoPayload() });
    await deliver("issue_comment", { action: "created", issue: issue(), comment: comment({ body: "a".repeat(1000) }), repository: repoPayload() });
    const line = FakeWorld.text(world.messagesIn(world.threads[0]!.id)[1]);
    expect(line).toContain(`${"a".repeat(297)}...`);
    expect(line).not.toContain("a".repeat(301));
  });

  it("a comment on an open issue without a thread starts one with the issue card", async () => {
    const { world, deliver } = await harness();
    await deliver("issue_comment", { action: "created", issue: issue(41), comment: comment(), repository: repoPayload() });
    expect(world.threads).toHaveLength(1);
    const messages = world.messagesIn(world.threads[0]!.id);
    expect(messages).toHaveLength(2);
    expect(FakeWorld.text(messages[0])).toContain("**dave** opened this issue");
    expect(FakeWorld.text(messages[1])).toContain("**erin** [commented]");
  });

  it("ignores comments on pull requests", async () => {
    const { world, deliver } = await harness();
    const onPull = issue(12, { pull_request: { url: "https://api.github.com/repos/OpenDrone-hw/OpenRX/pulls/12" } });
    await deliver("issue_comment", { action: "created", issue: onPull, comment: comment(), repository: repoPayload() });
    await deliver("issues", { action: "opened", issue: onPull, repository: repoPayload() });
    expect(world.discordPosts()).toEqual([]);
  });

  it("posts nothing for private repositories or a payload without the private flag", async () => {
    const { world, deliver } = await harness();
    const hidden = repoPayload("OpenRX", { private: true });
    const unflagged = repoPayload();
    delete unflagged.private;
    for (const repository of [hidden, unflagged]) {
      await deliver("issues", { action: "opened", issue: issue(), repository });
      await deliver("issue_comment", { action: "created", issue: issue(), comment: comment(), repository });
      await deliver("issues", { action: "closed", issue: issue(7, { state: "closed" }), repository });
    }
    expect(world.calls).toEqual([]);
  });

  it("closed: close card in the thread, thread archived, feed line", async () => {
    const { world, deliver } = await harness();
    await deliver("issues", { action: "opened", issue: issue(), repository: repoPayload() });
    const threadId = world.threads[0]!.id;
    await deliver("issues", {
      action: "closed",
      issue: issue(7, { state: "closed", state_reason: "completed" }),
      repository: repoPayload(),
      sender: { login: "stan" },
    });
    expect(errors).not.toHaveBeenCalled();
    const messages = world.messagesIn(threadId);
    expect(FakeWorld.text(messages[1])).toContain("**stan** closed this issue as completed");
    const archive = world.calls.find((c) => c.method === "PATCH" && c.url.endsWith(`/channels/${threadId}`));
    expect(archive?.body).toEqual({ archived: true });
    expect(FakeWorld.text(world.messagesIn(FEED)[1])).toContain("**OpenRX** issue #7 closed by stan");
  });

  it("reopened: card in the existing thread", async () => {
    const { world, deliver } = await harness();
    await deliver("issues", { action: "opened", issue: issue(), repository: repoPayload() });
    await deliver("issues", { action: "closed", issue: issue(7, { state: "closed" }), repository: repoPayload() });
    await deliver("issues", { action: "reopened", issue: issue(), repository: repoPayload(), sender: { login: "stan" } });
    expect(world.threads).toHaveLength(1);
    const messages = world.messagesIn(world.threads[0]!.id);
    expect(FakeWorld.text(messages[2])).toContain("**stan** reopened this issue");
  });
});

describe("scheduled: open issue threads stay open", () => {
  it("unarchives the thread of an open issue without posting, and leaves closed issues archived", async () => {
    const db = sqliteD1();
    const { world, deliver, services } = await harness({ db });
    await deliver("issues", { action: "opened", issue: issue(7), repository: repoPayload() });
    await deliver("issues", { action: "opened", issue: issue(8), repository: repoPayload() });
    await deliver("issues", { action: "closed", issue: issue(8, { state: "closed" }), repository: repoPayload() });
    const [open, closed] = world.threads;
    world.threadChannels.get(open!.id)!.thread_metadata = { archived: true };
    const before = world.discordPosts().length;

    await githubModule.scheduled!({} as ScheduledController, services);

    const after = world.discordPosts().slice(before);
    expect(after).toHaveLength(1);
    expect(after[0]?.method).toBe("PATCH");
    expect(after[0]?.url).toContain(`/channels/${open!.id}`);
    expect(after[0]?.body).toEqual({ archived: false });
    expect(world.threadChannels.get(closed!.id)?.thread_metadata).toEqual({ archived: true });
    expect(errors).not.toHaveBeenCalled();
  });

  it("forgets a deleted thread so the next event starts a new one", async () => {
    const db = sqliteD1();
    const { world, deliver, services } = await harness({ db });
    await deliver("issues", { action: "opened", issue: issue(7), repository: repoPayload() });
    world.goneThreads.add(world.threads[0]!.id);
    await githubModule.scheduled!({} as ScheduledController, services);
    expect((await issueStoreFor(db)!.get("OpenDrone-hw/OpenRX", 7))?.threadId).toBeNull();
    await deliver("issue_comment", { action: "created", issue: issue(7), comment: comment(), repository: repoPayload() });
    expect(world.threads).toHaveLength(2);
  });
});
