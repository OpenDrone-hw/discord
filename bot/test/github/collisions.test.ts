import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  MAX_OTHER_PULLS,
  collisionMarker,
  kicadFiles,
  pairKey,
  warnedFiles,
} from "../../src/github/collisions.ts";
import { EXISTING_THREAD, FORUM_RX, FakeWorld, GUILD, OTHER_FORUM_THREAD, RULES, harness, pullJson, repoPayload } from "./fakes.ts";

const OTHER_THREAD = "1600000000000000888";
const link = (thread: string) => `Discussion: https://discord.com/channels/${GUILD}/${thread}`;
const PCB = "hardware/OpenRX.kicad_pcb";
const SCH = "hardware/OpenRX.kicad_sch";

let errors: MockInstance;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function event(action: string, pull: object, repository = repoPayload()) {
  return { action, pull_request: pull, repository, after: "f".repeat(40) };
}

async function twoPulls(mine: string[], theirs: string[]) {
  const world = new FakeWorld();
  world.messages.set(OTHER_THREAD, []);
  world.threadChannels.set(OTHER_THREAD, { id: OTHER_THREAD, type: 11, parent_id: FORUM_RX });
  const h = await harness({ world });
  const other = world.addPull("OpenRX", pullJson("OpenRX", 10, { body: link(OTHER_THREAD), title: "Rework power" }), theirs);
  const pull = world.addPull("OpenRX", pullJson("OpenRX", 12, { body: link(EXISTING_THREAD), title: "Move antenna" }), mine);
  return { ...h, world, other, pull };
}

describe("helpers", () => {
  it("selects KiCad board and schematic files", () => {
    expect(kicadFiles(["b.kicad_sch", "README.md", "a.KICAD_PCB", "x.kicad_pro", "lib.kicad_sym"])).toEqual([
      "a.KICAD_PCB",
      "b.kicad_sch",
    ]);
  });

  it("round-trips markers, orders pairs and ignores markers from people", () => {
    const marker = collisionMarker(15, 12, ["a b.kicad_pcb", "c|d.kicad_sch"]);
    expect(marker).toBe("<!-- opendrone-kicad-collision pair=12,15 files=a%20b.kicad_pcb|c%7Cd.kicad_sch -->");
    expect(pairKey(15, 12)).toEqual([12, 15]);
    const comments = [
      { id: 1, body: `text\n${marker}`, isBot: true },
      { id: 2, body: collisionMarker(12, 15, ["forged.kicad_pcb"]), isBot: false },
      { id: 3, body: collisionMarker(12, 16, ["other.kicad_pcb"]), isBot: true },
      { id: 4, body: "<!-- opendrone-kicad-collision pair=12,15 files=%E0%A4%A -->", isBot: true },
    ];
    expect([...warnedFiles(comments, 12, 15)]).toEqual(["a b.kicad_pcb", "c|d.kicad_sch"]);
  });
});

describe("KiCad collision guard", () => {
  it("comments once on the PR and warns both threads", async () => {
    const { world, deliver, pull } = await twoPulls([PCB, SCH, "README.md"], [PCB, "docs/x.md"]);
    await deliver("pull_request", event("synchronize", { ...pull }));
    expect(errors).not.toHaveBeenCalled();

    const comments = world.comments.get("OpenRX#12") ?? [];
    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("**KiCad collision:** this pull request and #10 both change:");
    expect(comments[0]?.body).toContain(`- \`${PCB}\``);
    expect(comments[0]?.body).not.toContain(SCH);
    expect(comments[0]?.body).toContain(collisionMarker(12, 10, [PCB]));
    expect(world.comments.get("OpenRX#10")).toBeUndefined();

    const mine = world.messagesIn(EXISTING_THREAD).map((m) => FakeWorld.text(m));
    const theirs = world.messagesIn(OTHER_THREAD).map((m) => FakeWorld.text(m));
    expect(mine.some((t) => t.includes("KiCad collision with [OpenRX #10: Rework power]"))).toBe(true);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]).toContain("KiCad collision with [OpenRX #12: Move antenna]");
    expect(theirs[0]).toContain(`\`${PCB}\``);
  });

  it("stays quiet on repeated pushes and redeliveries", async () => {
    const { world, deliver, pull } = await twoPulls([PCB], [PCB]);
    await deliver("pull_request", event("synchronize", { ...pull }), "push-1");
    await deliver("pull_request", event("synchronize", { ...pull }), "push-2");
    await deliver("pull_request", event("synchronize", { ...pull }), "push-2");
    expect(world.comments.get("OpenRX#12")).toHaveLength(1);
    expect(world.messagesIn(OTHER_THREAD)).toHaveLength(1);
  });

  it("does not warn again when the other PR pushes", async () => {
    const { world, deliver, pull, other } = await twoPulls([PCB], [PCB]);
    await deliver("pull_request", event("synchronize", { ...pull }));
    await deliver("pull_request", event("synchronize", { ...other }));
    expect(world.comments.get("OpenRX#12")).toHaveLength(1);
    expect(world.comments.get("OpenRX#10")).toBeUndefined();
    expect(world.messagesIn(OTHER_THREAD).filter((m) => FakeWorld.text(m).includes("KiCad collision"))).toHaveLength(1);
  });

  it("does not post into the other PR's Discussion target unless it is a thread in this repository's forum", async () => {
    for (const target of [RULES, OTHER_FORUM_THREAD]) {
      const { world, deliver, pull, other } = await twoPulls([PCB], [PCB]);
      world.messages.set(target, []);
      other.body = link(target);
      await deliver("pull_request", event("synchronize", { ...pull }));
      expect(errors).not.toHaveBeenCalled();
      expect(world.comments.get("OpenRX#12")).toHaveLength(1);
      expect(world.messagesIn(target)).toHaveLength(0);
      expect(world.messagesIn(OTHER_THREAD)).toHaveLength(0);
      expect(world.messagesIn(EXISTING_THREAD).some((m) => FakeWorld.text(m).includes("KiCad collision"))).toBe(true);
    }
  });

  it("warns again when a new file starts to overlap", async () => {
    const { world, deliver, pull } = await twoPulls([PCB, SCH], [PCB]);
    await deliver("pull_request", event("synchronize", { ...pull }));
    world.files.set("OpenRX#10", [PCB, SCH]);
    await deliver("pull_request", event("synchronize", { ...pull }));
    const comments = world.comments.get("OpenRX#12") ?? [];
    expect(comments).toHaveLength(2);
    expect(comments[1]?.body).toContain(collisionMarker(10, 12, [PCB, SCH]));
  });

  it("ignores a forged marker from a person", async () => {
    const { world, deliver, pull } = await twoPulls([PCB], [PCB]);
    world.addComment("OpenRX", 12, collisionMarker(10, 12, [PCB]), "User");
    await deliver("pull_request", event("synchronize", { ...pull }));
    expect(world.comments.get("OpenRX#12")).toHaveLength(2);
  });

  it("stops after listing this PR's files when it changes no KiCad file", async () => {
    const { world, deliver, pull } = await twoPulls(["README.md"], [PCB]);
    await deliver("pull_request", event("synchronize", { ...pull }));
    const github = world.calls.filter((c) => c.url.startsWith("https://api.github.com/repos/"));
    expect(github.map((c) => new URL(c.url).pathname)).toEqual(["/repos/OpenDrone-hw/OpenRX/pulls/12/files"]);
  });

  it("reads every page of files", async () => {
    const many = Array.from({ length: 150 }, (_, i) => `docs/${i}.md`);
    const { world, deliver, pull } = await twoPulls([...many, PCB], [PCB]);
    await deliver("pull_request", event("synchronize", { ...pull }));
    expect(world.comments.get("OpenRX#12")).toHaveLength(1);
    const pages = world.calls.filter((c) => c.url.includes("/pulls/12/files")).map((c) => new URL(c.url).searchParams.get("page"));
    expect(pages).toEqual(["1", "2"]);
  });

  it("counts the old path of a renamed KiCad file", async () => {
    const { world, deliver, pull } = await twoPulls([`${PCB}=>hardware/renamed.kicad_pcb`], [PCB]);
    await deliver("pull_request", event("synchronize", { ...pull }));
    expect(world.comments.get("OpenRX#12")?.[0]?.body).toContain(`\`${PCB}\``);
  });

  it("also runs on opened, after the new thread exists", async () => {
    const world = new FakeWorld();
    world.messages.set(OTHER_THREAD, []);
    world.threadChannels.set(OTHER_THREAD, { id: OTHER_THREAD, type: 11, parent_id: FORUM_RX });
    const { deliver } = await harness({ world });
    world.addPull("OpenRX", pullJson("OpenRX", 10, { body: link(OTHER_THREAD) }), [PCB]);
    const pull = world.addPull("OpenRX", pullJson("OpenRX", 12), [PCB]);
    await deliver("pull_request", event("opened", { ...pull }));
    expect(world.threads).toHaveLength(1);
    const created = world.messagesIn(world.threads[0]!.id).map((m) => FakeWorld.text(m));
    expect(created).toHaveLength(2);
    expect(created[1]).toContain("KiCad collision with");
    expect(world.messagesIn(OTHER_THREAD)).toHaveLength(1);
  });

  it("comments but posts nothing to Discord for a private repository", async () => {
    const { world, deliver, pull } = await twoPulls([PCB], [PCB]);
    await deliver("pull_request", event("synchronize", { ...pull }, repoPayload("OpenRX", { private: true })));
    expect(world.comments.get("OpenRX#12")).toHaveLength(1);
    expect(world.discordPosts()).toEqual([]);
  });

  it("does not run on closed pull requests", async () => {
    const { world, deliver, pull } = await twoPulls([PCB], [PCB]);
    await deliver("pull_request", event("closed", { ...pull, state: "closed" }));
    expect(world.calls.some((c) => c.url.includes("/files"))).toBe(false);
  });

  it("compares at most MAX_OTHER_PULLS other PRs, newest first", async () => {
    const world = new FakeWorld();
    const { deliver } = await harness({ world });
    for (let n = 1; n <= MAX_OTHER_PULLS + 5; n++) world.addPull("OpenRX", pullJson("OpenRX", n), [PCB]);
    const pull = world.addPull("OpenRX", pullJson("OpenRX", 100), [PCB]);
    await deliver("pull_request", event("synchronize", { ...pull }));
    const listed = world.calls
      .map((c) => /\/pulls\/(\d+)\/files/.exec(c.url)?.[1])
      .filter((n): n is string => n !== undefined && n !== "100");
    expect(listed).toHaveLength(MAX_OTHER_PULLS);
    expect(listed).not.toContain("1");
    expect(world.comments.get("OpenRX#100")).toHaveLength(MAX_OTHER_PULLS);
  });
});
