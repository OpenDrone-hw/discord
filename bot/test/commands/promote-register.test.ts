import { afterEach, describe, expect, it } from "vitest";
import { commandsModule } from "../../src/commands/index.ts";
import { DISABLED, NOT_ADMIN, promoteCommand, repoNameProblem, timing } from "../../src/commands/promote.ts";
import { definitionProblems, splitDryRun } from "../../src/commands/register.ts";
import { createWorker, modules } from "../../src/index.ts";
import { Registry } from "../../src/registry.ts";
import { InteractionResponseType, MessageFlags } from "../../src/types.ts";
import { ed25519Signer, fakeContext, jsonResponse, nowSeconds } from "../helpers.ts";
import { harness, messageCommand, ROLE_ADMIN, ROLE_MEMBER, slash, text, THREAD, type Handler } from "./fixtures.ts";

const ADMINISTRATOR = String(1n << 3n);

describe("/promote", () => {
  const original = [...timing.topicRetryMs];
  afterEach(() => {
    timing.topicRetryMs = original;
  });

  function options(name = "OpenPDB", summary = "Power distribution board", isPrivate?: boolean) {
    const list: Array<{ name: string; value: unknown; type?: number }> = [
      { name: "name", value: name },
      { name: "summary", value: summary },
    ];
    if (isPrivate !== undefined) list.push({ name: "private", value: isPrivate, type: 5 });
    return list;
  }

  function github(generateStatus = 201, topicStatuses: number[] = [200]): Handler {
    let topicCall = 0;
    return (call, url) => {
      if (url.pathname === "/repos/OpenDrone-hw/hardware-template/generate") {
        return generateStatus === 201
          ? jsonResponse({ full_name: "OpenDrone-hw/OpenPDB", html_url: "https://github.com/OpenDrone-hw/OpenPDB" }, 201)
          : jsonResponse({ message: "Repository creation failed." }, generateStatus);
      }
      if (url.pathname === "/repos/OpenDrone-hw/OpenPDB/topics") {
        const status = topicStatuses[Math.min(topicCall++, topicStatuses.length - 1)] ?? 200;
        return jsonResponse(status === 200 ? { names: ["status-planned"] } : { message: "Not Found" }, status);
      }
      return undefined;
    };
  }

  async function run(opts = options(), handler: Handler = github(), env = { PROMOTE_ENABLED: "true" }, member = { roles: [ROLE_ADMIN] }) {
    const h = await harness(handler, env);
    const response = await promoteCommand.execute(h.ctx(slash("promote", opts, { member })));
    await h.settle();
    return { h, response, reply: text(h.lastEdit()) };
  }

  it("is refused unless PROMOTE_ENABLED is exactly \"true\"", async () => {
    for (const value of ["false", "TRUE", "1", ""]) {
      const { h, response } = await run(options(), github(), { PROMOTE_ENABLED: value });
      expect(text(response)).toBe(DISABLED);
      expect(h.calls).toHaveLength(0);
    }
  });

  it("creates the repository from the template and sets status-planned", async () => {
    const { h, response, reply } = await run();
    expect(response).toEqual({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: MessageFlags.EPHEMERAL },
    });
    expect(h.find("POST", "/repos/OpenDrone-hw/hardware-template/generate")[0]?.body).toEqual({
      owner: "OpenDrone-hw",
      name: "OpenPDB",
      description: "Power distribution board",
      private: false,
      include_all_branches: false,
    });
    expect(h.find("PUT", "/repos/OpenDrone-hw/OpenPDB/topics")[0]?.body).toEqual({ names: ["status-planned"] });
    expect(reply).toContain("Created public repository OpenDrone-hw/OpenPDB from hardware-template with topic status-planned");
    expect(reply).toContain("Add OpenPDB to bot/config/repos.json");
  });

  it("creates a private repository when asked", async () => {
    const { h, reply } = await run(options("OpenPDB", "x", true));
    expect((h.find("POST", "/repos/OpenDrone-hw/hardware-template/generate")[0]?.body as { private: boolean }).private).toBe(true);
    expect(reply).toContain("Created private repository");
  });

  it("accepts Administrator permission as admin and refuses everyone else", async () => {
    expect((await run(options(), github(), undefined, { roles: [], permissions: ADMINISTRATOR } as never)).reply).toContain("Created");
    const member = await run(options(), github(), undefined, { roles: [ROLE_MEMBER] });
    expect(member.reply).toBe(NOT_ADMIN);
    expect(member.h.calls.some((c) => c.url.startsWith("https://api.github.com"))).toBe(false);
  });

  it("validates the name and summary before deferring", async () => {
    for (const name of ["bad name", "..", "x.git", "a/b"]) {
      const { response, h } = await run(options(name));
      expect(text(response)).toContain("is not a repository name");
      expect(h.calls).toHaveLength(0);
    }
    expect(text((await run(options("OpenRX"))).response)).toBe("OpenRX is already in bot/config/repos.json.");
    expect(text((await run(options("OpenPDB", "   "))).response)).toContain("Give a summary");
    expect(repoNameProblem("OpenPDB-v2_x.1")).toBeNull();
  });

  it("retries the topic while GitHub finishes creating the repository", async () => {
    timing.topicRetryMs = [1, 1];
    const { h, reply } = await run(options(), github(201, [404, 200]));
    expect(h.find("PUT", "/repos/OpenDrone-hw/OpenPDB/topics")).toHaveLength(2);
    expect(reply).toContain("with topic status-planned");
    const failed = await run(options(), github(201, [404]));
    expect(failed.h.find("PUT", "/repos/OpenDrone-hw/OpenPDB/topics")).toHaveLength(3);
    expect(failed.reply).toContain("but setting topic status-planned failed");
  });

  it("explains GitHub refusals", async () => {
    expect((await run(options(), github(422))).reply).toContain("it may already exist");
    expect((await run(options(), github(403))).reply).toContain('needs "Administration: Read and write"');
  });
});

describe("command registration", () => {
  const definitions = new Registry(modules).commandDefinitions();

  it("registers the eight commands and the modal handler", () => {
    expect(definitions.map((d) => `${d.type}:${d.name}`)).toEqual([
      "1:link",
      "1:branch",
      "1:editing",
      "1:verify",
      "1:promote",
      "1:posting",
      "3:To GitHub issue",
      "3:Approve build",
    ]);
    expect(commandsModule.components?.map((c) => c.prefix)).toEqual(["to-issue"]);
  });

  it("makes every command guild-only with explicit default permissions", () => {
    expect(definitionProblems(definitions)).toEqual([]);
    const perms = Object.fromEntries(definitions.map((d) => [d.name, d.default_member_permissions]));
    expect(perms.promote).toBe(ADMINISTRATOR);
    expect(perms.posting).toBe(ADMINISTRATOR);
    expect(perms["Approve build"]).toBe(ADMINISTRATOR);
    expect(perms.link).toBe(String(1n << 11n));
    for (const d of definitions) expect(d.contexts).toEqual([0]);
    // Definitions do not share arrays.
    expect(definitions[0]?.contexts).not.toBe(definitions[1]?.contexts);
  });

  it("flags invalid definitions", () => {
    expect(
      definitionProblems([
        { name: "Bad Name", type: 1, description: "x", default_member_permissions: "0", contexts: [0] },
        { name: "ok", description: "", contexts: [0, 1] },
        { name: "Menu", type: 3, description: "no", default_member_permissions: "0", contexts: [0] },
        { name: "ok", type: 1, description: "dup", default_member_permissions: "0", contexts: [0] },
      ]),
    ).toEqual([
      "Bad Name: slash command names are 1-32 lowercase characters",
      "ok: description must be 1-100 characters",
      "ok: default_member_permissions must be set",
      "ok: contexts must be [0] (guild only)",
      "Menu: context-menu commands take no description",
      "ok: registered twice",
    ]);
  });

  it("splits --dry-run from the other arguments", () => {
    expect(splitDryRun(["--dry-run"])).toEqual({ dryRun: true, rest: [] });
    expect(splitDryRun(["--yes"])).toEqual({ dryRun: false, rest: ["--yes"] });
  });
});

describe("through the Worker", () => {
  async function post(body: unknown, handler: Handler = () => undefined) {
    const signer = await ed25519Signer();
    const h = await harness(handler, {});
    const env = { ...h.env, DISCORD_PUBLIC_KEY: signer.publicKeyHex };
    const worker = createWorker({ services: () => h.services });
    const text = JSON.stringify(body);
    const timestamp = nowSeconds();
    const request = new Request("https://bot.example.workers.dev/interactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature-Ed25519": await signer.sign(timestamp, text),
        "X-Signature-Timestamp": timestamp,
      },
      body: text,
    });
    const context = fakeContext();
    const response = await worker.fetch!(request as Request<unknown, IncomingRequestCfProperties>, env, context.ctx);
    await h.settle();
    return { h, json: (await response.json()) as { type: number; data: Record<string, any> } };
  }

  it("answers autocomplete for /editing", async () => {
    const { json } = await post(slash("editing", [{ name: "repo", value: "charg", focused: true }], { type: 4 }));
    expect(json).toEqual({ type: 8, data: { choices: [{ name: "Charger", value: "Charger" }] } });
  });

  it("opens the issue modal for the message command", async () => {
    const message = { id: "1700000000000000020", content: "Broken", author: { id: "1730000000000000002", username: "bob" } };
    const { json } = await post(messageCommand("To GitHub issue", message));
    expect(json.type).toBe(InteractionResponseType.MODAL);
    expect(json.data.custom_id).toBe(`to-issue:${THREAD}:${message.id}:${message.author.id}`);
  });

  it("refuses /promote with PROMOTE_ENABLED unset and never mentions anyone", async () => {
    const { json } = await post(slash("promote", [{ name: "name", value: "X" }, { name: "summary", value: "Y" }]));
    expect(json.data.content).toBe(DISABLED);
    expect(json.data.allowed_mentions).toEqual({ parse: [] });
  });
});
