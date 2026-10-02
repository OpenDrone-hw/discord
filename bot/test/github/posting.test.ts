import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeState, NOT_ADMIN, postingCommand } from "../../src/commands/posting.ts";
import { githubModule } from "../../src/github/index.ts";
import { issueStoreFor } from "../../src/github/issues.ts";
import { postingEnabled, postingState, setStoredPosting } from "../../src/posting.ts";
import { harness as commandHarness, ROLE_ADMIN, ROLE_MEMBER, slash, text } from "../commands/fixtures.ts";
import { brokenD1, CHANNEL_RX, EXISTING_THREAD, FEED, GUILD, harness, pullJson, repoPayload, sqliteD1 } from "./fakes.ts";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const PCB = "hardware/OpenRX.kicad_pcb";

function issue(number = 7, overrides: Record<string, unknown> = {}) {
  return {
    number,
    title: "UART2 pads swapped",
    body: "Swapped.",
    html_url: `https://github.com/OpenDrone-hw/OpenRX/issues/${number}`,
    user: { login: "dave", type: "User" },
    state: "open",
    ...overrides,
  };
}

const release = {
  tag_name: "v1.0.0",
  name: "v1.0.0",
  body: "",
  html_url: "https://github.com/OpenDrone-hw/OpenRX/releases/tag/v1.0.0",
  author: { login: "carol" },
  assets: [],
};

async function deliverEverything(h: Awaited<ReturnType<typeof harness>>): Promise<Response[]> {
  h.world.addPull("OpenRX", pullJson("OpenRX", 5));
  return [
    await h.deliver("pull_request", { action: "opened", pull_request: pullJson("OpenRX", 5), repository: repoPayload() }, "d-pr"),
    await h.deliver("issues", { action: "opened", issue: issue(), repository: repoPayload() }, "d-issue"),
    await h.deliver(
      "issue_comment",
      { action: "created", issue: issue(), comment: { body: "hi", user: { login: "erin", type: "User" } }, repository: repoPayload() },
      "d-comment",
    ),
    await h.deliver("release", { action: "published", release, repository: repoPayload() }, "d-release"),
    await h.deliver(
      "repository",
      { action: "edited", changes: { topics: { from: ["status-alpha"] } }, repository: repoPayload("OpenRX", { topics: ["status-beta"] }) },
      "d-repo",
    ),
    await h.deliver(
      "push",
      { ref: "refs/heads/main", after: "a".repeat(40), commits: [{}], head_commit: { message: "x" }, repository: repoPayload() },
      "d-push",
    ),
  ];
}

describe("posting switch state", () => {
  it("is on by default and off when the var or the D1 row says off", async () => {
    const db = sqliteD1();
    expect(await postingEnabled({ DB: db })).toBe(true);
    expect(await postingEnabled({ DB: db, DISCORD_POSTING: "on" })).toBe(true);
    expect(await postingEnabled({ DB: db, DISCORD_POSTING: " OFF " })).toBe(false);
    await setStoredPosting(db, "off", "stan");
    expect(await postingState({ DB: db })).toEqual({ enabled: false, variable: "unset", stored: "off" });
    await setStoredPosting(db, "on", "stan");
    expect(await postingEnabled({ DB: db })).toBe(true);
    // The var wins over a D1 "on".
    expect(await postingEnabled({ DB: db, DISCORD_POSTING: "off" })).toBe(false);
  });

  it("falls back to the var alone when D1 is broken", async () => {
    expect(await postingEnabled({ DB: brokenD1() })).toBe(true);
    expect(await postingEnabled({ DB: brokenD1(), DISCORD_POSTING: "off" })).toBe(false);
  });
});

describe("kill switch off", () => {
  for (const how of ["var", "d1"] as const) {
    it(`(${how}) makes no Discord call, answers 2xx and records the deliveries as skipped`, async () => {
      const db = sqliteD1();
      const h = await harness({ db });
      if (how === "var") h.env.DISCORD_POSTING = "off";
      else await setStoredPosting(db, "off", "stan");

      const responses = await deliverEverything(h);
      for (const response of responses) expect(response.status).toBe(202);
      expect(h.world.calls.filter((c) => c.url.startsWith("https://discord.com/"))).toEqual([]);
      const skipped = db.sqlite.prepare("SELECT key FROM github_deliveries WHERE state = 'skipped' ORDER BY key").all();
      expect(skipped.map((r) => (r as { key: string }).key)).toEqual([
        "d-comment:skipped",
        "d-issue:skipped",
        "d-pr:skipped",
        "d-push:skipped",
        "d-release:skipped",
        "d-repo:skipped",
      ]);
    });
  }

  it("posts again once switched back on, including a redelivery of a skipped delivery", async () => {
    const db = sqliteD1();
    const h = await harness({ db });
    await setStoredPosting(db, "off", "stan");
    const payload = { action: "published", release, repository: repoPayload() };
    await h.deliver("release", payload, "d-1");
    expect(h.world.discordPosts()).toEqual([]);
    await setStoredPosting(db, "on", "stan");
    await h.deliver("release", payload, "d-1");
    expect(h.world.messagesIn(CHANNEL_RX)).toHaveLength(1);
    expect(h.world.messagesIn(FEED)).toHaveLength(1);
  });

  it("keeps the KiCad collision guard commenting on GitHub", async () => {
    const h = await harness();
    h.env.DISCORD_POSTING = "off";
    h.world.addPull("OpenRX", pullJson("OpenRX", 10, { title: "Rework power" }), [PCB]);
    const body = `Discussion: https://discord.com/channels/${GUILD}/${EXISTING_THREAD}`;
    const pull = h.world.addPull("OpenRX", pullJson("OpenRX", 12, { body }), [PCB]);
    await h.deliver("pull_request", { action: "opened", pull_request: pull, repository: repoPayload() });
    const comments = h.world.comments.get("OpenRX#12") ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("KiCad collision");
    expect(h.world.calls.filter((c) => c.url.startsWith("https://discord.com/"))).toEqual([]);
  });

  it("keeps issue states current and stops the scheduled unarchive", async () => {
    const db = sqliteD1();
    const h = await harness({ db });
    await h.deliver("issues", { action: "opened", issue: issue(), repository: repoPayload() });
    const threadId = h.world.threads[0]!.id;
    h.world.threadChannels.get(threadId)!.thread_metadata = { archived: true };
    h.env.DISCORD_POSTING = "off";
    const before = h.world.calls.length;
    await githubModule.scheduled!({} as ScheduledController, h.services);
    expect(h.world.calls.slice(before)).toEqual([]);
    await h.deliver("issues", { action: "closed", issue: issue(7, { state: "closed" }), repository: repoPayload() });
    expect((await issueStoreFor(db)!.get("OpenDrone-hw/OpenRX", 7))?.state).toBe("closed");
    expect(h.world.calls.slice(before).filter((c) => c.url.startsWith("https://discord.com/"))).toEqual([]);
  });
});

describe("/posting", () => {
  async function run(state: string | undefined, roles: string[], env: Record<string, string> = {}) {
    const db = sqliteD1();
    const h = await commandHarness(undefined, { DB: db, ...env });
    const options = state ? [{ name: "state", value: state }] : [];
    const response = await postingCommand.execute(h.ctx(slash("posting", options, { member: { roles } })));
    return { db, response: text(response as never) };
  }

  it("lets admins switch posting off and on", async () => {
    const off = await run("off", [ROLE_ADMIN]);
    expect(off.response).toContain("is **off**");
    expect(await postingEnabled({ DB: off.db })).toBe(false);
    const on = await run("on", [ROLE_ADMIN]);
    expect(on.response).toContain("is **on**");
  });

  it("refuses everyone else and changes nothing", async () => {
    const { db, response } = await run("off", [ROLE_MEMBER]);
    expect(response).toBe(NOT_ADMIN);
    expect(await postingEnabled({ DB: db })).toBe(true);
  });

  it("reports that the var overrides /posting on", async () => {
    const { response } = await run("on", [ROLE_ADMIN], { DISCORD_POSTING: "off" });
    expect(response).toContain("is **off**");
    expect(response).toContain("cannot override");
    expect(describeState({ enabled: true, variable: "unset", stored: "unset" })).toContain("is **on**");
  });
});
