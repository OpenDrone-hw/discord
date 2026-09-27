import { describe, expect, it, vi } from "vitest";
import { approveBuildCommand, NOT_REVIEWER } from "../../src/commands/approve-build.ts";
import {
  issueBody,
  modalValues,
  NOT_MEMBER,
  NOT_THREAD,
  PREFIX,
  SLOW,
  suggestedTitle,
  toIssueCommand,
  toIssueModal,
} from "../../src/commands/to-issue.ts";
import { InteractionResponseType, MessageFlags, type Interaction } from "../../src/types.ts";
import { jsonResponse } from "../helpers.ts";
import {
  ALICE,
  APP,
  BOB,
  GEN_CHAT,
  GUILD,
  harness,
  MESSAGE,
  messageCommand,
  ROLE_ADMIN,
  ROLE_BUILDER,
  ROLE_MEMBER,
  ROLE_REVIEWER,
  rxThread,
  TAG_LITE,
  TAG_OPENRX,
  text,
  THREAD,
  type Handler,
} from "./fixtures.ts";

const MESSAGE_LINK = `https://discord.com/channels/${GUILD}/${THREAD}/${MESSAGE}`;
const bobMessage = {
  id: MESSAGE,
  content: "## The **VTX** overheats\nAfter 2 minutes at 800 mW it shuts down.",
  author: { id: BOB, username: "bob" },
  attachments: [{ filename: "thermal.jpg", url: "https://cdn.discordapp.com/x" }],
};

type Modal = { type: number; data: { custom_id: string; title: string; components: Array<Record<string, any>> } };

describe("To GitHub issue: modal", () => {
  it("opens a modal prefilled from the message with the tagged repository preselected", async () => {
    const h = await harness();
    const response = (await toIssueCommand.execute(h.ctx(messageCommand("To GitHub issue", bobMessage)))) as unknown as Modal;
    expect(response.type).toBe(InteractionResponseType.MODAL);
    expect(response.data.custom_id).toBe(`${PREFIX}:${THREAD}:${MESSAGE}:${BOB}`);
    expect(response.data.custom_id.length).toBeLessThanOrEqual(100);
    const [repo, title, body] = response.data.components;
    expect(repo?.component.options.map((o: { value: string }) => o.value)).toEqual([
      "OpenRX",
      "OpenRX-Lite",
      "OpenRX-Lite-UFL",
      "OpenRX-Mono",
      "OpenRX-Gemini",
    ]);
    expect(repo?.component.options.filter((o: { default: boolean }) => o.default).map((o: { value: string }) => o.value)).toEqual(["OpenRX"]);
    expect(title?.component.value).toBe("The VTX overheats");
    expect(body?.component.value).toBe(`${bobMessage.content}\n\nAttachments in the Discord message: thermal.jpg`);
    expect(h.calls.some((c) => c.url.startsWith("https://api.github.com"))).toBe(false);
  });

  it("offers only the tagged repositories when several are tagged, none preselected", async () => {
    const h = await harness();
    const channel = rxThread({ applied_tags: [TAG_OPENRX, TAG_LITE] });
    const response = (await toIssueCommand.execute(h.ctx(messageCommand("To GitHub issue", bobMessage, { channel })))) as unknown as Modal;
    const options = response.data.components[0]?.component.options;
    expect(options).toEqual([
      { label: "OpenRX", value: "OpenRX", default: false },
      { label: "OpenRX-Lite", value: "OpenRX-Lite", default: false },
    ]);
  });

  it("omits empty prefill values", async () => {
    const h = await harness();
    const response = (await toIssueCommand.execute(
      h.ctx(messageCommand("To GitHub issue", { id: MESSAGE, content: "", author: { id: BOB } })),
    )) as unknown as Modal;
    expect(response.data.components[1]?.component.value).toBeUndefined();
    expect(response.data.components[2]?.component.value).toBeUndefined();
  });

  it("refuses non-members and messages outside development forums", async () => {
    const h = await harness();
    const notMember = await toIssueCommand.execute(h.ctx(messageCommand("To GitHub issue", bobMessage, { member: { roles: [] } })));
    expect(text(notMember)).toBe(NOT_MEMBER);
    expect(notMember.data).toMatchObject({ flags: MessageFlags.EPHEMERAL });
    const outside = await toIssueCommand.execute(
      h.ctx(messageCommand("To GitHub issue", bobMessage, { channel: { id: GEN_CHAT, type: 0 } })),
    );
    expect(text(outside)).toBe(NOT_THREAD);
  });

  it("answers within the time budget when Discord is slow", async () => {
    vi.useFakeTimers();
    try {
      const h = await harness((call, url) =>
        url.pathname.endsWith("/roles") ? new Promise<Response>(() => {}) : undefined,
      );
      const pending = toIssueCommand.execute(h.ctx(messageCommand("To GitHub issue", bobMessage)));
      await vi.advanceTimersByTimeAsync(2_300);
      expect(text(await pending)).toBe(SLOW);
    } finally {
      vi.useRealTimers();
    }
  });

  it("suggests a title from the first non-empty line", () => {
    expect(suggestedTitle("\n\n> **Bold** `start` ||x||\nsecond")).toBe("Bold start x");
    expect(suggestedTitle("- item")).toBe("item");
    expect(suggestedTitle("x".repeat(300)).length).toBe(100);
    expect(suggestedTitle("")).toBe("");
  });
});

describe("To GitHub issue: submit", () => {
  function submission(values: { repo?: string; title?: string; body?: string }, overrides: Partial<Interaction> = {}): Interaction {
    const components: unknown[] = [];
    if (values.repo !== undefined) components.push({ type: 18, component: { type: 3, custom_id: "repo", values: [values.repo] } });
    if (values.title !== undefined) components.push({ type: 18, component: { type: 4, custom_id: "title", value: values.title } });
    if (values.body !== undefined) components.push({ type: 1, components: [{ type: 4, custom_id: "body", value: values.body }] });
    return {
      id: "1600000000000000003",
      application_id: APP,
      type: 5,
      token: "interaction-token",
      guild_id: GUILD,
      channel_id: THREAD,
      channel: rxThread(),
      member: { user: { id: ALICE, username: "alice" }, roles: [ROLE_MEMBER], permissions: "2048" },
      data: { custom_id: `${PREFIX}:${THREAD}:${MESSAGE}:${BOB}`, components },
      ...overrides,
    };
  }

  const github: Handler = (call, url) => {
    if (url.pathname === "/repos/OpenDrone-hw/OpenRX/issues" && call.method === "POST") {
      return jsonResponse({ number: 41, html_url: "https://github.com/OpenDrone-hw/OpenRX/issues/41" }, 201);
    }
    if (url.pathname === `/api/v10/users/${BOB}`) return jsonResponse({ id: BOB, username: "bob" });
    if (url.pathname === `/api/v10/channels/${THREAD}/messages`) return jsonResponse({ id: "reply" });
    return undefined;
  };

  it("creates the issue with a link back, replies to the message and answers ephemerally", async () => {
    const h = await harness(github);
    const response = await toIssueModal.handle(h.ctx(submission({ repo: "OpenRX", title: " VTX overheats ", body: "Details" })));
    expect(response).toEqual({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: MessageFlags.EPHEMERAL },
    });
    await h.settle();
    const issue = h.find("POST", "/repos/OpenDrone-hw/OpenRX/issues")[0];
    expect(issue?.body).toEqual({ title: "VTX overheats", body: issueBody("Details", MESSAGE_LINK, "bob", "alice") });
    expect((issue?.body as { body: string }).body).toContain(`From [a Discord message](${MESSAGE_LINK}) by bob, filed by alice`);
    const reply = h.find("POST", `/channels/${THREAD}/messages`)[0]?.body as Record<string, unknown>;
    expect(reply.content).toBe("Filed as OpenRX#41: <https://github.com/OpenDrone-hw/OpenRX/issues/41>");
    expect(reply.message_reference).toEqual({ message_id: MESSAGE, channel_id: THREAD, fail_if_not_exists: false });
    expect(reply.allowed_mentions).toEqual({ parse: [] });
    expect(text(h.lastEdit())).toBe("Created OpenRX#41: <https://github.com/OpenDrone-hw/OpenRX/issues/41>");
  });

  it("still answers when the thread reply or author lookup fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const h = await harness((call, url) => {
      if (url.pathname.startsWith("/api/v10/users/") || url.pathname.endsWith(`/channels/${THREAD}/messages`)) {
        return jsonResponse({ message: "no" }, 403);
      }
      return github(call, url);
    });
    await toIssueModal.handle(h.ctx(submission({ repo: "OpenRX", title: "T", body: "" })));
    await h.settle();
    const body = (h.find("POST", "/repos/OpenDrone-hw/OpenRX/issues")[0]?.body as { body: string }).body;
    expect(body).toBe(`From [a Discord message](${MESSAGE_LINK}) by a Discord user, filed by alice with the OpenDrone Discord bot.\n`);
    expect(text(h.lastEdit())).toContain("Created OpenRX#41");
  });

  it("refuses a repository outside the thread's forum, an empty title and non-members", async () => {
    const h = await harness(github);
    await toIssueModal.handle(h.ctx(submission({ repo: "Charger", title: "T" })));
    await h.settle();
    expect(text(h.lastEdit())).toBe("Charger is not discussed in #receivers.");
    await toIssueModal.handle(h.ctx(submission({ repo: "OpenRX", title: "   " })));
    await h.settle();
    expect(text(h.lastEdit())).toBe("The issue needs a title.");
    const outsider = submission({ repo: "OpenRX", title: "T" });
    outsider.member = { user: { id: ALICE, username: "alice" }, roles: [], permissions: "2048" };
    await toIssueModal.handle(h.ctx(outsider));
    await h.settle();
    expect(text(h.lastEdit())).toBe(NOT_MEMBER);
    expect(h.find("POST", "/repos/OpenDrone-hw/OpenRX/issues")).toHaveLength(0);
  });

  it("rejects a malformed custom_id", async () => {
    const h = await harness(github);
    const response = await toIssueModal.handle(h.ctx(submission({ repo: "OpenRX", title: "T" }, { data: { custom_id: `${PREFIX}:x:y` } })));
    expect(text(response)).toBe("This form is out of date.");
    expect(h.calls).toHaveLength(0);
  });

  it("reads Label and Action Row modal layouts", () => {
    const values = modalValues([
      { type: 18, component: { type: 3, custom_id: "repo", values: ["A", 3] } },
      { type: 1, components: [{ type: 4, custom_id: "title", value: "T" }] },
      { type: 10, content: "text display" },
    ]);
    expect(values.get("repo")).toEqual(["A"]);
    expect(values.get("title")).toEqual(["T"]);
    expect(values.size).toBe(2);
  });
});

describe("Approve build", () => {
  function handler(status = 204, code?: number): Handler {
    return (call, url) =>
      call.method === "PUT" && url.pathname === `/api/v10/guilds/${GUILD}/members/${BOB}/roles/${ROLE_BUILDER}`
        ? jsonResponse(code === undefined ? null : { code, message: "x" }, status)
        : undefined;
  }

  async function run(roles: string[], message: Record<string, unknown> = bobMessage, h?: Awaited<ReturnType<typeof harness>>) {
    const harnessed = h ?? (await harness(handler()));
    const response = await approveBuildCommand.execute(harnessed.ctx(messageCommand("Approve build", message, { member: { roles } })));
    await harnessed.settle();
    return { h: harnessed, response, reply: text(harnessed.lastEdit()) };
  }

  it("gives Verified Builder to the author with an audit reason, answering ephemerally", async () => {
    const { h, response, reply } = await run([ROLE_REVIEWER]);
    expect(response).toEqual({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: MessageFlags.EPHEMERAL },
    });
    const put = h.find("PUT", `/guilds/${GUILD}/members/${BOB}/roles/${ROLE_BUILDER}`);
    expect(put).toHaveLength(1);
    expect(decodeURIComponent(put[0]!.headers["x-audit-log-reason"] ?? "")).toBe(`Approve build by alice: ${MESSAGE_LINK}`);
    expect(reply).toBe(`Gave Verified Builder to bob for ${MESSAGE_LINK}.`);
    expect((await run([ROLE_ADMIN])).h.find("PUT", `/guilds/${GUILD}/members/${BOB}/roles/${ROLE_BUILDER}`)).toHaveLength(1);
  });

  it("refuses members without reviewer or admin", async () => {
    const { h, reply } = await run([ROLE_MEMBER]);
    expect(reply).toBe(NOT_REVIEWER);
    expect(h.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("refuses bots, webhooks and self-approval", async () => {
    expect((await run([ROLE_REVIEWER], { ...bobMessage, author: { id: BOB, username: "b", bot: true } })).reply).toContain("bot or webhook");
    expect((await run([ROLE_REVIEWER], { ...bobMessage, webhook_id: "1" })).reply).toContain("bot or webhook");
    expect((await run([ROLE_REVIEWER], { ...bobMessage, author: { id: ALICE, username: "alice" } })).reply).toBe(
      "You cannot approve your own build.",
    );
  });

  it("explains Discord refusals", async () => {
    expect((await run([ROLE_REVIEWER], bobMessage, await harness(handler(404, 10007)))).reply).toBe("The author is no longer on the server.");
    expect((await run([ROLE_REVIEWER], bobMessage, await harness(handler(403, 50013)))).reply).toContain(
      "its own role must be above Verified Builder",
    );
  });

  it("says when the role does not exist", async () => {
    const h = await harness((call, url) =>
      url.pathname === `/api/v10/guilds/${GUILD}/roles`
        ? jsonResponse([{ id: ROLE_REVIEWER, name: "reviewer" }])
        : undefined,
    );
    expect((await run([ROLE_REVIEWER], bobMessage, h)).reply).toBe("The role Verified Builder does not exist on the server.");
  });
});
