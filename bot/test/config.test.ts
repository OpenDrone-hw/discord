import { describe, expect, it } from "vitest";
import raw from "../config/repos.json" with { type: "json" };
import {
  ConfigError,
  Directory,
  DirectoryCache,
  config,
  findRepo,
  parseConfig,
  productChannels,
  reposInChannel,
} from "../src/config.ts";
import { DiscordClient } from "../src/discord.ts";
import { ChannelType } from "../src/types.ts";
import { BOT_TOKEN, jsonResponse, mockFetch } from "./helpers.ts";

// The product text channels in the Hardware and Software categories that carry pull request threads.
const PRODUCT_CHANNELS = [
  "fc",
  "aio",
  "esc",
  "rx",
  "vtx",
  "remote-id",
  "gps",
  "frame",
  "charger",
  "kicad-library",
  "fc-betaflight",
  "esc-am32",
  "rx-expresslrs",
  "opendrone-web",
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

  it("uses exactly the product channels", () => {
    expect(productChannels()).toEqual(PRODUCT_CHANNELS);
  });

  it("covers every organisation repository", () => {
    expect(Object.keys(config.repos).sort()).toEqual([...ORG_REPOS].sort());
  });

  it("maps repositories to their product channel", () => {
    expect(config.repos["OpenFC-Lite-Mini"]?.channel).toBe("fc");
    expect(config.repos["OpenAIO-Whoop"]?.channel).toBe("aio");
    expect(config.repos["OpenRX-Gemini"]?.channel).toBe("rx");
    expect(config.repos["OpenGPS"]?.channel).toBe("gps");
    expect(config.repos["OpenDrone-Fixtures"]?.channel).toBe("kicad-library");
    expect(config.repos["AM32"]?.channel).toBe("esc-am32");
    expect(config.repos["discord"]?.channel).toBe("opendrone-web");
    expect(reposInChannel("fc").map((r) => r.repo)).toEqual(["OpenFC-Lite", "OpenFC-Lite-Mini", "OpenFC"]);
  });
});

describe("parseConfig", () => {
  it("rejects a repository without a valid channel, an unknown key and a duplicate repository", () => {
    const noChannel = clone(raw) as { repos: Record<string, Record<string, unknown>> };
    delete noChannel.repos["OpenRX"]?.channel;
    expect(() => parseConfig(noChannel)).toThrow(/repos.OpenRX.channel/);

    const forum = clone(raw) as { repos: Record<string, Record<string, unknown>> };
    (forum.repos["OpenRX"] as Record<string, unknown>).forum = "receivers";
    expect(() => parseConfig(forum)).toThrow(/unknown key forum/);

    const repoClash = clone(raw) as { repos: Record<string, unknown> };
    repoClash.repos["openrx"] = { channel: "rx" };
    expect(() => parseConfig(repoClash)).toThrow(/listed twice/);

    const oldSchema = clone(raw) as Record<string, unknown>;
    oldSchema.forums = ["receivers"];
    expect(() => parseConfig(oldSchema)).toThrow(/unknown key forums/);
  });

  it("rejects a bot channel used as a product channel", () => {
    const feed = clone(raw) as { repos: Record<string, { channel: string }> };
    (feed.repos["OpenRX"] as { channel: string }).channel = "git-feed";
    expect(() => parseConfig(feed)).toThrow(/bot channel/);
  });

  it("rejects missing channels, roles and lifecycle names", () => {
    const noChannel = clone(raw) as { channels: Record<string, unknown> };
    delete noChannel.channels.gitFeed;
    expect(() => parseConfig(noChannel)).toThrow(ConfigError);

    const noRole = clone(raw) as { roles: Record<string, unknown> };
    delete noRole.roles.maintainer;
    expect(() => parseConfig(noRole)).toThrow(/roles.maintainer/);

    const noLifecycle = clone(raw) as { lifecycle: Record<string, unknown> };
    delete noLifecycle.lifecycle["status-beta"];
    expect(() => parseConfig(noLifecycle)).toThrow(/status-beta/);
  });

  it("rejects channel names Discord would change", () => {
    const upper = clone(raw) as { channels: Record<string, string> };
    upper.channels.gitFeed = "Git Feed";
    expect(() => parseConfig(upper)).toThrow(/not a Discord channel name/);

    const product = clone(raw) as { repos: Record<string, { channel: string }> };
    (product.repos["OpenRX"] as { channel: string }).channel = "RX";
    expect(() => parseConfig(product)).toThrow(/not a Discord channel name/);
  });
});

describe("findRepo", () => {
  it("matches full and short names case-insensitively", () => {
    expect(findRepo("OpenDrone-hw/OpenRX-Lite")).toEqual({ repo: "OpenRX-Lite", channel: "rx" });
    expect(findRepo("opendrone-hw/openrx-lite")?.repo).toBe("OpenRX-Lite");
    expect(findRepo("ExpressLRS")?.channel).toBe("rx-expresslrs");
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
    { id: "200", type: ChannelType.GUILD_FORUM, name: "rx", available_tags: [] },
    { id: "201", type: ChannelType.GUILD_TEXT, name: "rx" },
    { id: "202", type: ChannelType.GUILD_FORUM, name: "vtx", available_tags: [] },
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

  it("resolves a repository to its product text channel", async () => {
    const { directory } = setup();
    expect(await directory.resolveRepo("OpenDrone-hw/openrx-lite")).toEqual({
      repo: "OpenRX-Lite",
      channel: "rx",
      channelId: "201",
    });
    expect(await directory.resolveRepo("other/OpenRX")).toBeNull();
    // A forum with the product channel's name is not a product channel.
    await expect(directory.resolveRepo("OpenDrone-hw/OpenVTX")).rejects.toThrow(/text channel vtx .* does not exist/);
  });

  it("refuses ambiguous names", async () => {
    const { directory } = setup();
    await expect(directory.channelByName("dupe")).rejects.toThrow(/ambiguous/);
    await expect(directory.channelByName("rx")).rejects.toThrow(/ambiguous/);
    expect((await directory.channelByName("rx", [ChannelType.GUILD_TEXT]))?.id).toBe("201");
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
