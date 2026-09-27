import { describe, expect, it } from "vitest";
import raw from "../config/repos.json" with { type: "json" };
import {
  ConfigError,
  Directory,
  DirectoryCache,
  LIFECYCLE_TOPICS,
  MAX_FORUM_TAGS,
  config,
  findRepo,
  parseConfig,
} from "../src/config.ts";
import { DiscordClient } from "../src/discord.ts";
import { ChannelType } from "../src/types.ts";
import { BOT_TOKEN, jsonResponse, mockFetch } from "./helpers.ts";

const DEVELOPMENT_FORUMS = [
  "flight-controllers",
  "escs",
  "receivers",
  "video",
  "remote-id-gps",
  "frames",
  "power",
  "library",
  "firmware",
  "web-and-tools",
];

// Every OpenDrone-hw repository the bot posts about.
const ORG_REPOS = [
  "OpenFC-Lite",
  "OpenFC-Lite-Mini",
  "OpenFC",
  "OpenAIO",
  "OpenAIO-Whoop",
  "OpenESC-20x20",
  "OpenESC-30x30",
  "OpenRX",
  "OpenRX-Lite",
  "OpenRX-Lite-UFL",
  "OpenRX-Mono",
  "OpenRX-Gemini",
  "OpenVTX",
  "OpenRemoteID",
  "OpenGPS",
  "OpenFrame-3F",
  "OpenFrame-5F",
  "Charger",
  "KiCad-Library",
  "OpenDrone-Fixtures",
  "hardware-template",
  "OpenDrone-Web",
  "OpenDrone-Brand",
  ".github",
  "betaflight",
  "AM32",
  "ExpressLRS",
  "discord",
];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("repos.json", () => {
  it("parses", () => {
    expect(config.org).toBe("OpenDrone-hw");
  });

  it("lists exactly the development forums", () => {
    expect(config.forums).toEqual(DEVELOPMENT_FORUMS);
  });

  it("covers every organisation repository", () => {
    expect(Object.keys(config.repos).sort()).toEqual([...ORG_REPOS].sort());
  });

  it("puts every forum to use", () => {
    const used = new Set(Object.values(config.repos).map((r) => r.forum));
    expect([...used].sort()).toEqual([...DEVELOPMENT_FORUMS].sort());
  });

  it("keeps each forum within Discord's tag limit with room for work-type tags", () => {
    for (const forum of config.forums) {
      const products = Object.values(config.repos).filter((r) => r.forum === forum).length;
      expect(products + LIFECYCLE_TOPICS.length).toBeLessThanOrEqual(MAX_FORUM_TAGS - 5);
    }
  });

  it("maps repositories to their product line", () => {
    expect(config.repos["OpenAIO-Whoop"]?.forum).toBe("flight-controllers");
    expect(config.repos["OpenRX-Gemini"]?.forum).toBe("receivers");
    expect(config.repos["OpenGPS"]?.forum).toBe("remote-id-gps");
    expect(config.repos["AM32"]?.forum).toBe("firmware");
    expect(config.repos["Charger"]?.forum).toBe("power");
  });
});

describe("parseConfig", () => {
  it("rejects a repository in an unknown forum", () => {
    const bad = clone(raw) as { repos: Record<string, { forum: string }> };
    (bad.repos["OpenRX"] as { forum: string }).forum = "rx";
    expect(() => parseConfig(bad)).toThrow(/rx is not in forums/);
  });

  it("rejects a duplicate tag within a forum and a duplicate repository", () => {
    const tagClash = clone(raw) as { repos: Record<string, { tag: string }> };
    (tagClash.repos["OpenRX-Lite"] as { tag: string }).tag = "openrx";
    expect(() => parseConfig(tagClash)).toThrow(/already used/);

    const repoClash = clone(raw) as { repos: Record<string, unknown> };
    repoClash.repos["openrx"] = { forum: "receivers", tag: "x" };
    expect(() => parseConfig(repoClash)).toThrow(/listed twice/);
  });

  it("rejects missing channels, roles and lifecycle tags", () => {
    const noChannel = clone(raw) as { channels: Record<string, unknown> };
    delete noChannel.channels.gitFeed;
    expect(() => parseConfig(noChannel)).toThrow(ConfigError);

    const noRole = clone(raw) as { roles: Record<string, unknown> };
    delete noRole.roles.maintainer;
    expect(() => parseConfig(noRole)).toThrow(/roles.maintainer/);

    const noLifecycle = clone(raw) as { lifecycleTags: Record<string, unknown> };
    delete noLifecycle.lifecycleTags["status-beta"];
    expect(() => parseConfig(noLifecycle)).toThrow(/status-beta/);
  });

  it("rejects channel names Discord would change, and long tags", () => {
    const upper = clone(raw) as { channels: Record<string, string> };
    upper.channels.gitFeed = "Git Feed";
    expect(() => parseConfig(upper)).toThrow(/not a Discord channel name/);

    const long = clone(raw) as { repos: Record<string, { tag: string }> };
    (long.repos["OpenRX"] as { tag: string }).tag = "x".repeat(21);
    expect(() => parseConfig(long)).toThrow(/at most 20/);
  });

  it("rejects a forum with more than 20 product and lifecycle tags", () => {
    const crowded = clone(raw) as { repos: Record<string, unknown> };
    for (let i = 0; i < 15; i++) crowded.repos[`Extra-${i}`] = { forum: "video", tag: `Extra-${i}` };
    expect(() => parseConfig(crowded)).toThrow(/exceed/);
  });
});

describe("findRepo", () => {
  it("matches full and short names case-insensitively", () => {
    expect(findRepo("OpenDrone-hw/OpenRX-Lite")).toEqual({ repo: "OpenRX-Lite", forum: "receivers", tag: "OpenRX-Lite" });
    expect(findRepo("opendrone-hw/openrx-lite")?.repo).toBe("OpenRX-Lite");
    expect(findRepo("ExpressLRS")?.forum).toBe("firmware");
  });

  it("returns null for other organisations and unknown repositories", () => {
    expect(findRepo("someone/OpenRX")).toBeNull();
    expect(findRepo("OpenDrone-hw/unknown")).toBeNull();
    expect(findRepo("a/b/c")).toBeNull();
    expect(findRepo("")).toBeNull();
  });
});

describe("Directory", () => {
  const GUILD = "1494019459822653512";
  const channels = [
    { id: "100", type: ChannelType.GUILD_ANNOUNCEMENT, name: "git-feed" },
    { id: "101", type: ChannelType.GUILD_ANNOUNCEMENT, name: "announcements" },
    {
      id: "200",
      type: ChannelType.GUILD_FORUM,
      name: "receivers",
      available_tags: [
        { id: "t1", name: "OpenRX-Lite" },
        { id: "t2", name: "Beta" },
      ],
    },
    { id: "201", type: ChannelType.GUILD_TEXT, name: "receivers" },
    { id: "300", type: ChannelType.GUILD_TEXT, name: "dupe" },
    { id: "301", type: ChannelType.GUILD_TEXT, name: "dupe" },
  ];
  const roles = [
    { id: "r1", name: "Verified Builder" },
    { id: "r2", name: "reviewer" },
  ];

  function setup(now = { t: 0 }) {
    const { fetch, calls } = mockFetch((call) =>
      jsonResponse(call.url.endsWith("/channels") ? channels : roles),
    );
    const discord = new DiscordClient({ token: BOT_TOKEN, fetch });
    const directory = new Directory(discord, GUILD, { cache: new DirectoryCache(), ttlMs: 1000, now: () => now.t });
    return { directory, calls, now };
  }

  it("resolves channels and roles by configured name", async () => {
    const { directory } = setup();
    expect(await directory.channelId("gitFeed")).toBe("100");
    expect(await directory.channelId("announcements")).toBe("101");
    expect(await directory.channelId("modLog")).toBeNull();
    expect(await directory.roleId("verifiedBuilder")).toBe("r1");
    expect(await directory.roleId("maintainer")).toBeNull();
  });

  it("resolves a repository to its forum and product tag", async () => {
    const { directory } = setup();
    expect(await directory.resolveRepo("OpenDrone-hw/openrx-lite")).toEqual({
      repo: "OpenRX-Lite",
      forum: "receivers",
      tag: "OpenRX-Lite",
      forumId: "200",
      tagId: "t1",
    });
    const openRx = await directory.resolveRepo("OpenDrone-hw/OpenRX");
    expect(openRx?.forumId).toBe("200");
    expect(openRx?.tagId).toBeNull();
    expect(await directory.resolveRepo("other/OpenRX")).toBeNull();
    await expect(directory.resolveRepo("OpenDrone-hw/OpenVTX")).rejects.toThrow(/forum video .* does not exist/);
  });

  it("finds lifecycle tags case-insensitively", async () => {
    const { directory } = setup();
    const forum = await directory.forum("receivers");
    expect(forum?.id).toBe("200");
    expect(directory.lifecycleTagId(forum!, "status-beta")).toBe("t2");
    expect(directory.lifecycleTagId(forum!, "status-alpha")).toBeNull();
  });

  it("refuses ambiguous names", async () => {
    const { directory } = setup();
    await expect(directory.channelByName("dupe")).rejects.toThrow(/ambiguous/);
    await expect(directory.channelByName("receivers")).rejects.toThrow(/ambiguous/);
    expect((await directory.channelByName("receivers", [ChannelType.GUILD_TEXT]))?.id).toBe("201");
  });

  it("caches lists for the TTL and refetches after it or after invalidate()", async () => {
    const { directory, calls, now } = setup();
    await directory.channelId("gitFeed");
    await directory.channelId("announcements");
    await directory.roleId("reviewer");
    await directory.roleId("verifiedBuilder");
    expect(calls).toHaveLength(2);
    now.t = 1500;
    await directory.channelId("gitFeed");
    expect(calls).toHaveLength(3);
    directory.invalidate();
    await directory.roleId("reviewer");
    expect(calls).toHaveLength(4);
  });

  it("does not cache a failed fetch", async () => {
    let fail = true;
    const { fetch, calls } = mockFetch(() => (fail ? jsonResponse({ message: "boom" }, 500) : jsonResponse(channels)));
    const directory = new Directory(new DiscordClient({ token: BOT_TOKEN, fetch }), GUILD, { cache: new DirectoryCache() });
    await expect(directory.channelId("gitFeed")).rejects.toThrow();
    fail = false;
    expect(await directory.channelId("gitFeed")).toBe("100");
    expect(calls).toHaveLength(2);
  });
});
