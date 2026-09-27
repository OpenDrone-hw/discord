import { describe, expect, it } from "vitest";
import { USAGE, run, type RunDeps } from "../../scripts/register-metadata.ts";
import { UsageError } from "../../scripts/lib.ts";
import { DiscordClient } from "../../src/discord.ts";
import { METADATA_RECORDS } from "../../src/linked-roles/metadata.ts";
import { BOT_TOKEN, jsonResponse, mockFetch } from "../helpers.ts";
import { APP } from "./harness.ts";

function deps() {
  const out: string[] = [];
  const discord = mockFetch((call) => jsonResponse(call.body));
  let clients = 0;
  const d: RunDeps = {
    write: (text) => void out.push(text),
    applicationId: () => APP,
    client: () => {
      clients += 1;
      return new DiscordClient({ token: BOT_TOKEN, fetch: discord.fetch });
    },
  };
  return { d, out, discord, clients: () => clients };
}

describe("register-metadata", () => {
  it("prints the schema and stops by default and with --dry-run", async () => {
    for (const argv of [[], ["--dry-run"], ["--dry-run", "--yes"], ["--yes", "--dry-run"]]) {
      const { d, out, clients } = deps();
      await run(argv, d);
      const text = out.join("");
      expect(text).toContain(`PUT /applications/${APP}/role-connections/metadata`);
      expect(text).toContain('"key": "merged_prs"');
      expect(text).toContain("Dry run.");
      expect(clients()).toBe(0);
    }
  });

  it("sends the four records with --yes", async () => {
    const { d, out, discord } = deps();
    await run(["--yes"], d);
    expect(discord.calls).toHaveLength(1);
    expect(discord.calls[0]?.method).toBe("PUT");
    expect(discord.calls[0]?.url).toBe(`https://discord.com/api/v10/applications/${APP}/role-connections/metadata`);
    expect(discord.calls[0]?.body).toEqual(METADATA_RECORDS);
    expect(out.join("")).toContain("Registered 4 metadata records.");
    expect(out.join("")).not.toContain(BOT_TOKEN);
  });

  it("prints usage and refuses unknown arguments", async () => {
    const { d, out } = deps();
    await run(["--help"], d);
    expect(out.join("")).toBe(USAGE);
    await expect(run(["--force"], d)).rejects.toThrow(UsageError);
  });
});
