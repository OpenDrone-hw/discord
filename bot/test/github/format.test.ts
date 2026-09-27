import { describe, expect, it } from "vitest";
import {
  Colors,
  MAX_TEXT,
  card,
  code,
  escapeMarkdown,
  feedLine,
  formatBytes,
  isGitHubUrl,
  link,
  plainExcerpt,
  releaseNotes,
  truncate,
} from "../../src/github/format.ts";
import { discussionUrl, parseDiscussion, threadName, withDiscussionLine } from "../../src/github/thread-link.ts";
import { GUILD } from "./fakes.ts";

describe("escaping", () => {
  it("escapes inline markdown and mention syntax in one line", () => {
    expect(escapeMarkdown("Fix **bold** _it_ `code` ~~x~~ ||spoiler||")).toBe(
      "Fix \\*\\*bold\\*\\* \\_it\\_ \\`code\\` \\~\\~x\\~\\~ \\|\\|spoiler\\|\\|",
    );
    expect(escapeMarkdown("[click](https://evil.example) <@123> <t:1:R>")).toBe(
      "\\[click\\]\\(https://evil.example\\) \\<@123\\> \\<t:1:R\\>",
    );
    expect(escapeMarkdown("# big\nsecond line")).toBe("\\# big second line");
    expect(escapeMarkdown("-# small")).toBe("\\-# small");
    expect(escapeMarkdown("OpenRX-Lite v1.0")).toBe("OpenRX-Lite v1.0");
  });

  it("makes code spans without backticks", () => {
    expect(code("feat/`evil`")).toBe("`feat/evil`");
    expect(code("")).toBe("`?`");
  });

  it("links only to GitHub", () => {
    expect(isGitHubUrl("https://github.com/OpenDrone-hw/OpenRX/pull/1")).toBe(true);
    expect(isGitHubUrl("https://github.com.evil.example/x")).toBe(false);
    expect(isGitHubUrl("http://github.com/x")).toBe(false);
    expect(link("A [b]", "https://github.com/x")).toBe("[A \\[b\\]](https://github.com/x)");
    expect(link("A", "javascript:alert(1)")).toBe("A");
  });

  it("reduces untrusted markdown to plain text", () => {
    const body = [
      "<!-- template: delete me -->",
      "Adds the [datasheet](https://evil.example/x) and ![img](https://img.example/a.png)",
      "<details><summary>More</summary>hidden</details>",
      "",
      "",
      "",
      "Ping <@&123> and <t:1700000000:R>",
    ].join("\n");
    const text = plainExcerpt(body, 500);
    expect(text).not.toContain("template");
    expect(text).toContain("datasheet (https://evil.example/x)");
    expect(text).not.toContain("img.example");
    expect(text).not.toContain("<details>");
    expect(text).toContain("\\<@&123\\>");
    expect(text).not.toMatch(/\n{3}/);
    expect(plainExcerpt("x".repeat(50), 10)).toBe("xxxxxxx...");
  });

  it("keeps release markdown but drops HTML comments", () => {
    expect(releaseNotes("## Changes\n<!-- hidden -->\n- [PR](https://github.com/x)", 100)).toBe(
      "## Changes\n\n- [PR](https://github.com/x)",
    );
  });

  it("truncates and formats sizes", () => {
    expect(truncate("abcdef", 6)).toBe("abcdef");
    expect(truncate("abcdefg", 6)).toBe("abc...");
    expect(formatBytes(undefined)).toBe("");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("Components V2 messages", () => {
  it("builds a container card with a link button and no mentions", () => {
    const message = card({
      color: Colors.open,
      blocks: ["### title", "", "body"],
      button: { label: "Open on GitHub", url: "https://github.com/OpenDrone-hw/OpenRX/pull/1" },
    });
    expect(message).toEqual({
      flags: 1 << 15,
      allowed_mentions: { parse: [] },
      components: [
        {
          type: 17,
          accent_color: Colors.open,
          components: [
            { type: 10, content: "### title" },
            { type: 10, content: "body" },
            {
              type: 1,
              components: [{ type: 2, style: 5, label: "Open on GitHub", url: "https://github.com/OpenDrone-hw/OpenRX/pull/1" }],
            },
          ],
        },
      ],
    });
    expect(message.content).toBeUndefined();
    expect(message.embeds).toBeUndefined();
  });

  it("drops a non-GitHub button and caps total text", () => {
    const message = card({ color: 1, blocks: ["a".repeat(3000), "b".repeat(3000)], button: { label: "x", url: "https://evil.example" } });
    const container = (message.components as Array<{ components: Array<{ type: number; content?: string }> }>)[0];
    const texts = container?.components.filter((c) => c.type === 10) ?? [];
    expect(texts.reduce((n, c) => n + (c.content?.length ?? 0), 0)).toBeLessThanOrEqual(MAX_TEXT);
    expect(container?.components.some((c) => c.type === 1)).toBe(false);
  });

  it("builds a one-line feed message", () => {
    expect(feedLine("hello")).toEqual({
      flags: 1 << 15,
      components: [{ type: 10, content: "hello" }],
      allowed_mentions: { parse: [] },
    });
  });
});

describe("Discussion line", () => {
  const thread = "1500000000000000123";
  const url = discussionUrl(GUILD, thread);

  it("formats and parses the link", () => {
    expect(url).toBe(`https://discord.com/channels/${GUILD}/${thread}`);
    expect(parseDiscussion(`Adds a thing.\n\nDiscussion: ${url}`, GUILD)).toBe(thread);
    expect(parseDiscussion(`discussion:   <${url}>  `, GUILD)).toBe(thread);
    expect(parseDiscussion(`Discussion: https://ptb.discord.com/channels/${GUILD}/${thread}/1500000000000000999`, GUILD)).toBe(thread);
    expect(parseDiscussion(`Discussion: https://discordapp.com/channels/${GUILD}/${thread}/`, GUILD)).toBe(thread);
  });

  it("ignores other guilds, inline mentions and missing bodies", () => {
    expect(parseDiscussion(`Discussion: https://discord.com/channels/1111111111111111111/${thread}`, GUILD)).toBeNull();
    expect(parseDiscussion(`See the discussion: ${url} for context`, GUILD)).toBeNull();
    expect(parseDiscussion(`Discussion: https://discord.com.evil.example/channels/${GUILD}/${thread}`, GUILD)).toBeNull();
    expect(parseDiscussion("", GUILD)).toBeNull();
    expect(parseDiscussion(null, GUILD)).toBeNull();
    const other = `Discussion: https://discord.com/channels/1111111111111111111/1500000000000000001\nDiscussion: ${url}`;
    expect(parseDiscussion(other, GUILD)).toBe(thread);
  });

  it("appends the line after a blank line", () => {
    expect(withDiscussionLine("Body text\n\n", url)).toBe(`Body text\n\nDiscussion: ${url}`);
    expect(withDiscussionLine("", url)).toBe(`Discussion: ${url}`);
    expect(withDiscussionLine(null, url)).toBe(`Discussion: ${url}`);
    expect(parseDiscussion(withDiscussionLine("x", url), GUILD)).toBe(thread);
  });

  it("names threads within Discord's 100 characters", () => {
    expect(threadName("OpenRX", { number: 12, title: "Fix\nantenna" })).toBe("OpenRX #12: Fix antenna");
    expect(threadName("OpenRX", { number: 12, title: "x".repeat(200) })).toHaveLength(100);
  });
});
