import { describe, expect, it } from "vitest";
import { modules } from "../../src/index.ts";
import {
  EMPTY_METADATA,
  METADATA_RECORDS,
  encodeMetadata,
  metadataProblems,
  roleConnectionBody,
} from "../../src/linked-roles/metadata.ts";
import { Registry } from "../../src/registry.ts";

describe("role connection metadata", () => {
  it("registers the four records with the agreed types", () => {
    expect(METADATA_RECORDS.map((r) => [r.key, r.type])).toEqual([
      ["merged_prs", 2],
      ["org_member", 7],
      ["maintainer", 7],
      ["owner", 7],
    ]);
    expect(metadataProblems(METADATA_RECORDS)).toEqual([]);
    expect(new Registry(modules).roleConnectionMetadata()).toEqual(METADATA_RECORDS);
  });

  it("finds what Discord would reject", () => {
    const ok = { type: 7, key: "k", name: "n", description: "d" };
    expect(metadataProblems([{ ...ok, key: "Bad-Key" }])[0]).toMatch(/key must match/);
    expect(metadataProblems([ok, ok])[0]).toMatch(/duplicate key/);
    expect(metadataProblems([{ ...ok, type: 9 }])[0]).toMatch(/unknown type/);
    expect(metadataProblems([{ ...ok, name: "x".repeat(101) }])[0]).toMatch(/name/);
    expect(metadataProblems([{ ...ok, description: "" }])[0]).toMatch(/description/);
    const six = Array.from({ length: 6 }, (_, i) => ({ ...ok, key: `k${i}` }));
    expect(metadataProblems(six)[0]).toMatch(/exceed/);
  });

  it("encodes values as Discord strings", () => {
    expect(encodeMetadata({ merged_prs: 12.7, org_member: true, maintainer: false, owner: true })).toEqual({
      merged_prs: "12",
      org_member: "1",
      maintainer: "0",
      owner: "1",
    });
    expect(encodeMetadata({ ...EMPTY_METADATA, merged_prs: -3 }).merged_prs).toBe("0");
    expect(encodeMetadata({ ...EMPTY_METADATA, merged_prs: Number.NaN }).merged_prs).toBe("0");
  });

  it("names the platform GitHub and omits the username when unlinked", () => {
    expect(roleConnectionBody("alice", EMPTY_METADATA)).toEqual({
      platform_name: "GitHub",
      platform_username: "alice",
      metadata: { merged_prs: "0", org_member: "0", maintainer: "0", owner: "0" },
    });
    expect(roleConnectionBody(null, EMPTY_METADATA)).not.toHaveProperty("platform_username");
  });
});
