import { describe, expect, it } from "vitest";
import {
  branchSlug,
  code,
  escapeMarkdown,
  fitLines,
  focusedValue,
  forumThread,
  hasAdministrator,
  hasRole,
  repoChoices,
  stringOption,
  truncate,
  within,
} from "../../src/commands/util.ts";
import { jsonResponse } from "../helpers.ts";
import {
  FORUM_POWER,
  GEN_CHAT,
  harness,
  ROLE_ADMIN,
  ROLE_DEVELOPER,
  ROLE_MEMBER,
  rxThread,
  slash,
  TAG_LITE,
  TAG_OPENRX,
  THREAD,
} from "./fixtures.ts";

describe("text helpers", () => {
  it("slugs thread titles into branch names", () => {
    expect(branchSlug("Fix UART pinout on v2 (Rev. B)", "x")).toBe("fix-uart-pinout-on-v2-rev-b");
    expect(branchSlug("Crème brûlée: ÜBER test!!", "x")).toBe("creme-brulee-uber-test");
    expect(branchSlug("   ", "thread-1")).toBe("thread-1");
    expect(branchSlug("日本語", "thread-1")).toBe("thread-1");
    const long = branchSlug("a very long thread title that goes on and on about the receiver antenna layout", "x");
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long).toBe("a-very-long-thread-title-that-goes-on-and-on");
    expect(long.endsWith("-")).toBe(false);
  });

  it("escapes markdown and flattens newlines", () => {
    expect(escapeMarkdown("**bold** _x_ `c` <@123> [a](b)\n# h")).toBe(
      "\\*\\*bold\\*\\* \\_x\\_ \\`c\\` \\<@123\\> \\[a\\]\\(b\\) \\# h",
    );
    expect(code("a`b")).toBe("`a'b`");
  });

  it("truncates and fits lines within a limit", () => {
    expect(truncate("abcdef", 4)).toBe("a...");
    expect(truncate("abc", 4)).toBe("abc");
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i} ${"x".repeat(40)}`);
    const out = fitLines(lines, 500);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out).toMatch(/\(\d+ more lines not shown\)$/);
    expect(fitLines(["a", "b"], 500)).toBe("a\nb");
  });

  it("resolves with null after the timeout", async () => {
    expect(await within(Promise.resolve(1), 50)).toBe(1);
    expect(await within(new Promise(() => {}), 5)).toBeNull();
    expect(await within(new Promise((resolve) => setTimeout(() => resolve(2), 50)), 5)).toBeNull();
  });
});

describe("options", () => {
  it("reads string options, nested ones and the focused value", () => {
    const i = slash("x", [{ name: "repo", value: "  OpenRX ", focused: true }]);
    expect(stringOption(i, "repo")).toBe("OpenRX");
    expect(stringOption(i, "missing")).toBeUndefined();
    expect(focusedValue(i)).toBe("  OpenRX ");
    const nested = slash("x");
    nested.data!.options = [{ name: "sub", type: 1, options: [{ name: "pr", type: 3, value: "u" }] }];
    expect(stringOption(nested, "pr")).toBe("u");
  });

  it("autocompletes repositories, prefix matches first, at most 25", async () => {
    const h = await harness();
    const names = (typed: string) => repoChoices(h.ctx(slash("x", [{ name: "repo", value: typed, focused: true }]))).map((c) => c.value);
    expect(names("openrx-l")).toEqual(["OpenRX-Lite", "OpenRX-Lite-UFL"]);
    expect(names("lite")).toEqual(["OpenFC-Lite", "OpenFC-Lite-Mini", "OpenRX-Lite", "OpenRX-Lite-UFL"]);
    expect(names("").length).toBe(25);
    expect(names("zzz")).toEqual([]);
  });
});

describe("roles", () => {
  it("checks role ids resolved by name, and Administrator for admin", async () => {
    const h = await harness();
    expect(await hasRole(h.ctx(slash("x", [], { member: { roles: [ROLE_MEMBER] } })), ["member"])).toBe(true);
    expect(await hasRole(h.ctx(slash("x", [], { member: { roles: [ROLE_MEMBER] } })), ["admin", "developer"])).toBe(false);
    expect(await hasRole(h.ctx(slash("x", [], { member: { roles: [ROLE_DEVELOPER] } })), ["admin", "developer"])).toBe(true);
    expect(await hasRole(h.ctx(slash("x", [], { member: { roles: [ROLE_ADMIN] } })), ["admin"])).toBe(true);
    const owner = slash("x", [], { member: { roles: [], permissions: String(1n << 3n) } });
    expect(hasAdministrator(owner)).toBe(true);
    expect(await hasRole(h.ctx(owner), ["admin"])).toBe(true);
    expect(await hasRole(h.ctx(owner), ["reviewer"])).toBe(false);
    const noMember = slash("x");
    delete noMember.member;
    expect(await hasRole(h.ctx(noMember), ["member"])).toBe(false);
    // The role list is fetched once and cached.
    expect(h.find("GET", `/guilds/${h.env.GUILD_ID}/roles`)).toHaveLength(1);
  });
});

describe("forumThread", () => {
  it("uses the interaction's channel and maps tags to repositories", async () => {
    const h = await harness();
    const thread = await forumThread(h.ctx(slash("x", [], { channel: rxThread({ applied_tags: [TAG_OPENRX, TAG_LITE] }) })));
    expect(thread?.forum.name).toBe("receivers");
    expect(thread?.repos.map((r) => r.repo)).toEqual(["OpenRX", "OpenRX-Lite", "OpenRX-Lite-UFL", "OpenRX-Mono", "OpenRX-Gemini"]);
    expect(thread?.tagged.map((r) => r.repo)).toEqual(["OpenRX", "OpenRX-Lite"]);
    expect(h.find("GET", `/channels/${THREAD}`)).toHaveLength(0);
  });

  it("fetches the channel when the interaction lacks thread details", async () => {
    const h = await harness((call, url) =>
      url.pathname === `/api/v10/channels/${THREAD}` ? jsonResponse(rxThread({ applied_tags: [] })) : undefined,
    );
    const thread = await forumThread(h.ctx(slash("x", [], { channel: { id: THREAD, type: 11 } })));
    expect(thread?.tagged).toEqual([]);
    expect(h.find("GET", `/channels/${THREAD}`)).toHaveLength(1);
  });

  it("returns null outside development forum threads", async () => {
    const h = await harness((call, url) =>
      url.pathname === `/api/v10/channels/${GEN_CHAT}` ? jsonResponse({ id: GEN_CHAT, type: 0, parent_id: null }) : undefined,
    );
    expect(await forumThread(h.ctx(slash("x", [], { channel: { id: GEN_CHAT, type: 0 } })))).toBeNull();
    const unknownForum = rxThread({ parent_id: "1799999999999999999" });
    expect(await forumThread(h.ctx(slash("x", [], { channel: unknownForum })))).toBeNull();
    expect(await forumThread(h.ctx(slash("x", [], { channel: null })))).toBeNull();
    const power = await forumThread(h.ctx(slash("x", [], { channel: rxThread({ parent_id: FORUM_POWER, applied_tags: [] }) })));
    expect(power?.repos.map((r) => r.repo)).toEqual(["Charger"]);
  });
});
