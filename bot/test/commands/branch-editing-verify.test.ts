import { beforeEach, describe, expect, it } from "vitest";
import { branchCommand, branchInstructions } from "../../src/commands/branch.ts";
import { editingCommand, formatEditing, MAX_PULLS } from "../../src/commands/editing.ts";
import { clearVerificationUrlCache, verifyCommand, verifyMessage } from "../../src/commands/verify.ts";
import { InteractionResponseType, MessageFlags } from "../../src/types.ts";
import { jsonResponse } from "../helpers.ts";
import { CHANNEL_CHARGER, GEN_CHAT, GUILD, harness, OLD_FORUM_RX, ROLE_DEVELOPER, rxThread, slash, text, THREAD, type Handler } from "./fixtures.ts";

const EPHEMERAL_DEFER = { type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: MessageFlags.EPHEMERAL } };

describe("/branch", () => {
  async function run(options: Array<{ name: string; value: unknown }>, channel?: Record<string, unknown>) {
    const h = await harness();
    const extra = channel ? { channel } : {};
    const response = await branchCommand.execute(h.ctx(slash("branch", options, extra)));
    await h.settle();
    return { h, response, reply: text(h.lastEdit()) };
  }

  it("uses the repository the thread name names, and the title", async () => {
    const { response, reply, h } = await run([]);
    expect(response).toEqual(EPHEMERAL_DEFER);
    const threadLink = `https://discord.com/channels/${GUILD}/${THREAD}`;
    expect(reply).toBe(branchInstructions("OpenDrone-hw", "OpenRX", "openrx-fix-uart-pinout-on-v2-rev-b", threadLink));
    expect(reply).toContain(`\nDiscussion: ${threadLink}\n`);
    expect(reply.length).toBeLessThanOrEqual(2000);
    expect(reply).toContain("gh repo fork OpenDrone-hw/OpenRX --clone");
    expect(reply).toContain("git switch -c openrx-fix-uart-pinout-on-v2-rev-b");
    expect(reply).toContain("the bot starts a separate thread");
    expect(reply).not.toContain("forum");
    expect(reply).toContain("/editing repo:OpenRX");
    expect(h.calls.some((c) => c.url.startsWith("https://api.github.com"))).toBe(false);
  });

  it("asks for a repository when the thread names none or several", async () => {
    const none = await run([], rxThread({ name: "PR #12: move the antenna" }));
    expect(none.reply).toContain("OpenRX, OpenRX-Lite, OpenRX-Lite-UFL, OpenRX-Mono, OpenRX-Gemini");
    const two = await run([], rxThread({ name: "OpenRX and OpenRX-Lite: shared UART" }));
    expect(two.reply).toBe("This thread does not name one product. Run /branch repo:<name> with one of: OpenRX-Lite, OpenRX.");
  });

  it("takes the repo option, falls back to a single-repo channel, and uses the thread id for untitled threads", async () => {
    expect((await run([{ name: "repo", value: "openrx-mono" }])).reply).toContain("gh repo fork OpenDrone-hw/OpenRX-Mono --clone");
    const power = await run([], rxThread({ parent_id: CHANNEL_CHARGER, name: "!!!" }));
    expect(power.reply).toContain("gh repo fork OpenDrone-hw/Charger --clone");
    expect(power.reply).toContain(`git switch -c thread-${rxThread().id}`);
  });

  it("refuses a repository of another channel, so no Discussion line the GitHub module would reject is handed out", async () => {
    const other = await run([{ name: "repo", value: "Charger" }]);
    expect(other.reply).toBe(
      "Charger is discussed in #charger, not #rx; run /branch in a thread there. " +
        "This channel covers: OpenRX, OpenRX-Lite, OpenRX-Lite-UFL, OpenRX-Mono, OpenRX-Gemini.",
    );
    expect(other.reply).not.toContain("Discussion:");
    const unknown = await run([{ name: "repo", value: "Nope" }]);
    expect(unknown.reply).toBe(
      "`Nope` is not a repository in bot/config/repos.json. This channel covers: OpenRX, OpenRX-Lite, OpenRX-Lite-UFL, OpenRX-Mono, OpenRX-Gemini.",
    );
    expect(unknown.reply).not.toContain("Discussion:");
  });

  it("refuses outside product channel threads, the retired forum included", async () => {
    expect((await run([], { id: GEN_CHAT, type: 0 })).reply).toBe("Run /branch inside a thread of a product channel.");
    expect((await run([], rxThread({ parent_id: OLD_FORUM_RX }))).reply).toBe("Run /branch inside a thread of a product channel.");
  });

  describe("autocomplete", () => {
    async function choices(typed: string, channel?: Record<string, unknown> | null, handler?: Handler) {
      const h = await harness(handler);
      const extra = channel === undefined ? { type: 4 } : { type: 4, channel };
      const result = await branchCommand.autocomplete!(h.ctx(slash("branch", [{ name: "repo", value: typed, focused: true }], extra)));
      return { h, values: result.map((c) => c.value) };
    }

    it("offers only the repositories of the thread's channel, named ones first", async () => {
      expect((await choices("")).values).toEqual(["OpenRX", "OpenRX-Lite", "OpenRX-Lite-UFL", "OpenRX-Mono", "OpenRX-Gemini"]);
      expect((await choices("", rxThread({ name: "OpenRX-Lite: antenna" }))).values).toEqual([
        "OpenRX-Lite",
        "OpenRX",
        "OpenRX-Lite-UFL",
        "OpenRX-Mono",
        "OpenRX-Gemini",
      ]);
      expect((await choices("mono")).values).toEqual(["OpenRX-Mono"]);
      expect((await choices("openesc")).values).toEqual([]);
      expect((await choices("char")).values).toEqual([]);
      expect((await choices("", rxThread({ parent_id: CHANNEL_CHARGER }))).values).toEqual(["Charger"]);
    });

    it("offers nothing outside a product channel thread", async () => {
      expect((await choices("", { id: GEN_CHAT, type: 0 })).values).toEqual([]);
      expect((await choices("", null)).values).toEqual([]);
    });

    it("reads the thread from Discord when the interaction carries a partial channel", async () => {
      const handler: Handler = (call, url) =>
        call.method === "GET" && url.pathname === `/api/v10/channels/${THREAD}` ? jsonResponse(rxThread()) : undefined;
      const { h, values } = await choices("", { id: THREAD, type: 11 }, handler);
      expect(values).toEqual(["OpenRX", "OpenRX-Lite", "OpenRX-Lite-UFL", "OpenRX-Mono", "OpenRX-Gemini"]);
      expect(h.find("GET", `/channels/${THREAD}`)).toHaveLength(1);
    });
  });
});

describe("/editing", () => {
  const pulls = [
    { number: 3, title: "Move `USB` connector", html_url: "https://github.com/OpenDrone-hw/OpenRX/pull/3", user: { login: "alice" } },
    { number: 5, title: "Docs only", html_url: "https://github.com/OpenDrone-hw/OpenRX/pull/5", user: { login: "bob" } },
    { number: 8, title: "Reroute RF", html_url: "https://github.com/OpenDrone-hw/OpenRX/pull/8", user: { login: "carol" }, draft: true },
  ];
  const files: Record<number, unknown[]> = {
    3: [{ filename: "hw/OpenRX.kicad_pcb" }, { filename: "hw/OpenRX.kicad_sch" }, { filename: "README.md" }],
    5: [{ filename: "README.md" }],
    8: [{ filename: "hw/OpenRX.kicad_pcb" }, { filename: "hw/rf.kicad_sch", previous_filename: "hw/old-rf.kicad_sch" }],
  };

  function github(options: { private?: boolean; repoStatus?: number; pullList?: unknown[] } = {}): Handler {
    return (call, url) => {
      if (url.pathname === "/repos/OpenDrone-hw/OpenRX") {
        return options.repoStatus ? jsonResponse({ message: "Not Found" }, options.repoStatus) : jsonResponse({ private: options.private ?? false });
      }
      if (url.pathname === "/repos/OpenDrone-hw/OpenRX/pulls") return jsonResponse(options.pullList ?? pulls);
      const match = /^\/repos\/OpenDrone-hw\/OpenRX\/pulls\/(\d+)\/files$/.exec(url.pathname);
      if (match) return jsonResponse(url.searchParams.get("page") === "1" ? files[Number(match[1])] ?? [] : []);
      return undefined;
    };
  }

  async function run(repo: string, handler: Handler = github(), roles?: string[]) {
    const h = await harness(handler);
    const extra = roles ? { member: { roles } } : {};
    const response = await editingCommand.execute(h.ctx(slash("editing", [{ name: "repo", value: repo }], extra)));
    await h.settle();
    return { h, response, edit: h.lastEdit(), reply: text(h.lastEdit()) };
  }

  it("lists pull requests changing KiCad files and the files they share", async () => {
    const { response, reply, edit, h } = await run("openrx");
    expect(response).toEqual(EPHEMERAL_DEFER);
    expect(edit?.flags).toBe(MessageFlags.SUPPRESS_EMBEDS);
    expect(reply).toContain("**OpenRX**: 2 of 3 open pull requests change KiCad files.");
    expect(reply).toContain("Changed by more than one pull request (cannot be merged together):\n- `hw/OpenRX.kicad_pcb`: #3, #8");
    expect(reply).toContain("- [#3](<https://github.com/OpenDrone-hw/OpenRX/pull/3>) Move \\`USB\\` connector, by `alice`: `hw/OpenRX.kicad_pcb`, `hw/OpenRX.kicad_sch`");
    expect(reply).toContain("Reroute RF (draft), by `carol`: `hw/OpenRX.kicad_pcb`, `hw/old-rf.kicad_sch`, `hw/rf.kicad_sch`");
    expect(reply).not.toContain("Docs only");
    const list = h.find("GET", "/repos/OpenDrone-hw/OpenRX/pulls")[0];
    expect(new URL(list!.url).searchParams.get("state")).toBe("open");
  });

  it("pages through changed files", async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.txt` }));
    const handler: Handler = (call, url) => {
      if (url.pathname === "/repos/OpenDrone-hw/OpenRX") return jsonResponse({ private: false });
      if (url.pathname === "/repos/OpenDrone-hw/OpenRX/pulls") return jsonResponse([pulls[0]]);
      if (url.pathname.endsWith("/files")) {
        const page = url.searchParams.get("page");
        return jsonResponse(page === "3" ? [{ filename: "late.kicad_pcb" }] : many);
      }
      return undefined;
    };
    const { reply, h } = await run("OpenRX", handler);
    expect(reply).toContain("`late.kicad_pcb`");
    expect(h.find("GET", "/repos/OpenDrone-hw/OpenRX/pulls/3/files")).toHaveLength(3);
  });

  it("says so when nothing touches KiCad files", async () => {
    const { reply } = await run("OpenRX", github({ pullList: [pulls[1]] }));
    expect(reply).toBe("No open pull request in **OpenRX** changes a .kicad_pcb or .kicad_sch file (checked 1 open pull request).");
  });

  it("keeps private repositories to staff", async () => {
    const member = await run("OpenRX", github({ private: true }));
    expect(member.reply).toContain("is private");
    expect(member.h.find("GET", "/repos/OpenDrone-hw/OpenRX/pulls")).toHaveLength(0);
    const developer = await run("OpenRX", github({ private: true }), [ROLE_DEVELOPER]);
    expect(developer.reply).toContain("2 of 3 open pull requests");
  });

  it("rejects unknown repositories and reports missing ones", async () => {
    expect((await run("Nope")).reply).toContain("is not a repository in bot/config/repos.json");
    expect((await run("OpenRX", github({ repoStatus: 404 }))).reply).toBe("OpenDrone-hw/OpenRX was not found on GitHub.");
  });

  it("formats a cut list and stays inside Discord's message limit", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      number: i + 1,
      title: `Pull request ${i} ${"x".repeat(60)}`,
      url: `https://github.com/OpenDrone-hw/OpenRX/pull/${i + 1}`,
      author: "someone",
      draft: false,
      files: [`board${i}.kicad_pcb`],
    }));
    const out = formatEditing("OpenDrone-hw", "OpenRX", { pulls: many, open: MAX_PULLS, truncated: true });
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(out).toContain(`60 of the first ${MAX_PULLS} open pull requests`);
    expect(out).toMatch(/more lines not shown\)$/);
  });
});

describe("/verify", () => {
  beforeEach(() => clearVerificationUrlCache());

  function app(url: string | null): Handler {
    return (call, u) =>
      u.pathname === "/api/v10/applications/@me" ? jsonResponse({ id: "1", role_connections_verification_url: url }) : undefined;
  }

  it("links the application's verification URL with a link button", async () => {
    const h = await harness(app("https://bot.example.workers.dev/linked-roles"));
    const response = await verifyCommand.execute(h.ctx(slash("verify")));
    await h.settle();
    expect(response).toEqual(EPHEMERAL_DEFER);
    const edit = h.lastEdit();
    expect(text(edit)).toContain("**Contributor**, **Maintainer** and **Verified Owner**");
    expect(edit?.components).toEqual([
      { type: 1, components: [{ type: 2, style: 5, label: "Open verification page", url: "https://bot.example.workers.dev/linked-roles" }] },
    ]);
    // Cached: a second call does not read the application again.
    await verifyCommand.execute(h.ctx(slash("verify")));
    await h.settle();
    expect(h.find("GET", "/applications/@me")).toHaveLength(1);
  });

  it("says when no verification URL is set", async () => {
    for (const url of [null, "", "http://insecure.example"]) {
      clearVerificationUrlCache();
      const h = await harness(app(url));
      await verifyCommand.execute(h.ctx(slash("verify")));
      await h.settle();
      expect(text(h.lastEdit())).toContain("Verification is not set up yet");
      expect(h.lastEdit()?.components).toBeUndefined();
    }
  });

  it("names the organisation from the config", () => {
    const message = verifyMessage(null, "Example-org", { contributor: "C", maintainer: "M", owner: "O" });
    expect(message.content).toContain("merged in Example-org");
  });
});
