import { describe, expect, it, vi } from "vitest";
import { discussionUrl, linkCommand, parsePullRef, parseThreadUrl, replaceDiscussion, withDiscussion } from "../../src/commands/link.ts";
import { ERROR_TEXT } from "../../src/interactions.ts";
import { InteractionResponseType, MessageFlags } from "../../src/types.ts";
import { jsonResponse } from "../helpers.ts";
import { ALICE, APP, FORUM_POWER, FORUM_RX, GEN_CHAT, GH_TOKEN, GUILD, harness, ROLE_DEVELOPER, rxThread, slash, text, THREAD, type Handler } from "./fixtures.ts";

const THREAD_URL = `https://discord.com/channels/${GUILD}/${THREAD}`;
const PR_PATH = "/repos/OpenDrone-hw/OpenRX/pulls/12";

function pull(overrides: Record<string, unknown> = {}) {
  return {
    number: 12,
    title: "Swap **UART** pins",
    body: "Fixes the pinout.",
    html_url: "https://github.com/OpenDrone-hw/OpenRX/pull/12",
    base: { repo: { private: false } },
    ...overrides,
  };
}

function github(pr: Record<string, unknown> | number = pull()): Handler {
  return (call, url) => {
    if (url.pathname === PR_PATH && call.method === "GET") {
      return typeof pr === "number" ? jsonResponse({ message: "Not Found" }, pr) : jsonResponse(pr);
    }
    if (url.pathname === PR_PATH && call.method === "PATCH") return jsonResponse(pull());
    if (url.pathname === `/api/v10/channels/${THREAD}/messages`) return jsonResponse({ id: "m1" });
    return undefined;
  };
}

async function run(prText: string, handler: Handler = github(), extra: Parameters<typeof slash>[2] = {}) {
  const h = await harness(handler);
  const response = await linkCommand.execute(h.ctx(slash("link", [{ name: "pr", value: prText }], extra)));
  await h.settle();
  return { h, response, reply: text(h.lastEdit()) };
}

describe("discussion line helpers", () => {
  it("parses pull request references", () => {
    expect(parsePullRef("https://github.com/OpenDrone-hw/OpenRX/pull/12", "OpenDrone-hw")).toEqual({
      owner: "OpenDrone-hw",
      repo: "OpenRX",
      number: 12,
    });
    expect(parsePullRef("github.com/OpenDrone-hw/OpenRX/pull/12/files#diff", "OpenDrone-hw")?.number).toBe(12);
    expect(parsePullRef("OpenRX#7", "OpenDrone-hw")).toEqual({ owner: "OpenDrone-hw", repo: "OpenRX", number: 7 });
    expect(parsePullRef("someone/OpenRX#7", "OpenDrone-hw")?.owner).toBe("someone");
    expect(parsePullRef("https://github.com/OpenDrone-hw/OpenRX/issues/12", "OpenDrone-hw")).toBeNull();
    expect(parsePullRef("https://evil.example/github.com/OpenDrone-hw/OpenRX/pull/1", "OpenDrone-hw")).toBeNull();
  });

  it("reads and appends the Discussion line", () => {
    expect(discussionUrl("Text\n\nDiscussion: https://discord.com/channels/1/2\n")).toBe("https://discord.com/channels/1/2");
    expect(discussionUrl("No link here. Discussion: inline")).toBeNull();
    expect(discussionUrl(null)).toBeNull();
    expect(withDiscussion("Body\n\n", "U")).toBe("Body\n\nDiscussion: U\n");
    expect(withDiscussion(null, "U")).toBe("Discussion: U\n");
    expect(discussionUrl("  Discussion: <https://discord.com/channels/1/2>")).toBe("https://discord.com/channels/1/2");
    expect(replaceDiscussion("A\n\nDiscussion: https://x/1\nB", "U")).toBe("A\n\nDiscussion: U\nB");
    expect(parseThreadUrl(`https://discord.com/channels/${GUILD}/${THREAD}`)).toEqual({ guildId: GUILD, threadId: THREAD });
    expect(parseThreadUrl("https://discord.com/channels/1/2")).toBeNull();
    expect(parseThreadUrl("https://evil.example/channels/1494019459822653512/1700000000000000010")).toBeNull();
  });
});

describe("/link", () => {
  it("defers ephemerally, adds the Discussion line and announces it in the thread", async () => {
    const { h, response, reply } = await run("https://github.com/OpenDrone-hw/OpenRX/pull/12");
    expect(response).toEqual({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: MessageFlags.EPHEMERAL },
    });
    const patch = h.find("PATCH", PR_PATH);
    expect(patch).toHaveLength(1);
    expect(patch[0]?.body).toEqual({ body: `Fixes the pinout.\n\nDiscussion: ${THREAD_URL}\n` });
    expect(patch[0]?.headers.authorization).toBe(`Bearer ${GH_TOKEN}`);
    const note = h.find("POST", `/channels/${THREAD}/messages`)[0]?.body as Record<string, unknown>;
    expect(note.content).toContain("alice linked this thread to [OpenRX#12]");
    expect(note.content).toContain("Swap \\*\\*UART\\*\\* pins");
    expect(note.allowed_mentions).toEqual({ parse: [] });
    expect(note.flags).toBe(MessageFlags.SUPPRESS_EMBEDS);
    expect(reply).toContain("Linked this thread to [OpenRX#12](<https://github.com/OpenDrone-hw/OpenRX/pull/12>)");
  });

  it("accepts the short repo#number form", async () => {
    const { h } = await run("OpenRX#12");
    expect(h.find("PATCH", PR_PATH)).toHaveLength(1);
  });

  it("does nothing when the thread is already linked", async () => {
    const { h, reply } = await run("OpenRX#12", github(pull({ body: `x\n\nDiscussion: ${THREAD_URL}` })));
    expect(reply).toContain("already linked");
    expect(h.find("PATCH", PR_PATH)).toHaveLength(0);
    expect(h.find("POST", `/channels/${THREAD}/messages`)).toHaveLength(0);
  });

  it("refuses to replace another discussion link", async () => {
    const other = "https://discord.com/channels/1/999";
    const { h, reply } = await run("OpenRX#12", github(pull({ body: `Discussion: ${other}` })));
    expect(reply).toContain(`already names another discussion: <${other}>`);
    expect(h.find("PATCH", PR_PATH)).toHaveLength(0);
  });

  describe("an existing line naming another thread in this server", () => {
    const OTHER = "1700000000000000099";
    const OTHER_URL = `https://discord.com/channels/${GUILD}/${OTHER}`;
    const botBody = `Fixes the pinout.\n\nDiscussion: ${OTHER_URL}`;

    function withThread(owner: string | number): Handler {
      const base = github(pull({ body: botBody }));
      return (call, url) => {
        if (url.pathname === `/api/v10/channels/${OTHER}` && call.method === "GET") {
          return typeof owner === "number"
            ? jsonResponse({ message: "Unknown Channel", code: 10003 }, owner)
            : jsonResponse({ id: OTHER, type: 11, parent_id: FORUM_RX, owner_id: owner });
        }
        if (url.pathname === `/api/v10/channels/${OTHER}/messages` && call.method === "POST") return jsonResponse({ id: "m2" });
        return base(call, url);
      };
    }

    it("replaces a line pointing at a post the bot created and notes the move there", async () => {
      const { h, reply } = await run("OpenRX#12", withThread(APP));
      const patch = h.find("PATCH", PR_PATH);
      expect(patch).toHaveLength(1);
      expect(patch[0]?.body).toEqual({ body: `Fixes the pinout.\n\nDiscussion: ${THREAD_URL}` });
      const moved = h.find("POST", `/channels/${OTHER}/messages`)[0]?.body as Record<string, unknown>;
      expect(moved.content).toContain(`moved to ${THREAD_URL}`);
      expect(moved.allowed_mentions).toEqual({ parse: [] });
      expect(h.find("POST", `/channels/${THREAD}/messages`)).toHaveLength(1);
      expect(reply).toContain("Linked this thread to [OpenRX#12]");
    });

    it("replaces a line pointing at a deleted thread", async () => {
      const { h } = await run("OpenRX#12", withThread(404));
      expect(h.find("PATCH", PR_PATH)[0]?.body).toEqual({ body: `Fixes the pinout.\n\nDiscussion: ${THREAD_URL}` });
    });

    it("keeps a line pointing at a thread a person started", async () => {
      const { h, reply } = await run("OpenRX#12", withThread(ALICE));
      expect(reply).toContain(`already names another discussion: <${OTHER_URL}>`);
      expect(h.find("PATCH", PR_PATH)).toHaveLength(0);
      expect(h.find("POST", `/channels/${OTHER}/messages`)).toHaveLength(0);
    });

    it("keeps the line when the thread cannot be read", async () => {
      const { h, reply } = await run("OpenRX#12", withThread(403));
      expect(reply).toContain("already names another discussion");
      expect(h.find("PATCH", PR_PATH)).toHaveLength(0);
    });

    it("never replaces a bot thread URL from another server", async () => {
      const foreign = `https://discord.com/channels/1111111111111111111/${OTHER}`;
      const other = await run("OpenRX#12", (call, url) => {
        if (url.pathname === PR_PATH && call.method === "GET") return jsonResponse(pull({ body: `Discussion: ${foreign}` }));
        return withThread(APP)(call, url);
      });
      expect(other.reply).toContain(`already names another discussion: <${foreign}>`);
      expect(other.h.find("PATCH", PR_PATH)).toHaveLength(0);
      expect(other.h.find("GET", `/channels/${OTHER}`)).toHaveLength(0);
    });
  });

  it("refuses a repository discussed in another forum without calling GitHub", async () => {
    const { h, reply } = await run("https://github.com/OpenDrone-hw/Charger/pull/3");
    expect(reply).toBe("Charger is discussed in #power; open or pick a thread there.");
    expect(h.calls.some((c) => c.url.startsWith("https://api.github.com"))).toBe(false);
  });

  it("refuses outside a development forum thread", async () => {
    const { reply } = await run("OpenRX#12", github(), { channel: { id: GEN_CHAT, type: 0, parent_id: null, applied_tags: [] } });
    expect(reply).toBe("Run /link inside a thread of a development forum.");
    const power = await run("OpenRX#12", github(), { channel: rxThread({ parent_id: FORUM_POWER }) });
    expect(power.reply).toContain("discussed in #receivers");
  });

  it("refuses non-members before any GitHub call", async () => {
    const { h, reply } = await run("OpenRX#12", github(), { member: { roles: [] } });
    expect(reply).toBe("Only members can link pull requests.");
    expect(h.calls.some((c) => c.url.startsWith("https://api.github.com"))).toBe(false);
  });

  it("rejects unknown repositories, other organisations and non-PR text", async () => {
    expect((await run("https://github.com/OpenDrone-hw/Nope/pull/1")).reply).toContain("is not an OpenDrone-hw repository");
    expect((await run("https://github.com/someone/OpenRX/pull/1")).reply).toContain("someone/OpenRX is not");
    expect((await run("hello")).reply).toContain("is not a pull request link");
    expect((await run("OpenRX#0")).reply).toContain("is not a pull request link");
  });

  it("reports a missing pull request", async () => {
    expect((await run("OpenRX#12", github(404))).reply).toBe("OpenRX#12 does not exist.");
  });

  it("keeps private pull requests to staff", async () => {
    const privatePull = pull({ base: { repo: { private: true } } });
    const member = await run("OpenRX#12", github(privatePull));
    expect(member.reply).toContain("is private");
    expect(member.h.find("PATCH", PR_PATH)).toHaveLength(0);
    const developer = await run("OpenRX#12", github(privatePull), { member: { roles: [ROLE_DEVELOPER] } });
    expect(developer.h.find("PATCH", PR_PATH)).toHaveLength(1);
  });

  it("replaces the placeholder with the error text when GitHub fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await run("OpenRX#12", github(500))).reply).toBe(ERROR_TEXT);
  });

  it("asks for the option when it is empty, without deferring", async () => {
    const h = await harness();
    const response = await linkCommand.execute(h.ctx(slash("link", [{ name: "pr", value: "  " }])));
    expect(response.type).toBe(InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE);
    expect(h.calls).toHaveLength(0);
  });
});
