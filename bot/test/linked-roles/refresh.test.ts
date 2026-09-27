import { describe, expect, it, vi } from "vitest";
import { refreshLinkedUser } from "../../src/linked-roles/index.ts";
import { LinkedRolesContext } from "../../src/linked-roles/context.ts";
import { refreshStale } from "../../src/linked-roles/refresh.ts";
import { APP, ORG, harness, link, type Harness } from "./harness.ts";

const A = "111111111111111111";
const B = "222222222222222222";
const C = "333333333333333333";
const PUT_PATH = `discord.com/api/v10/users/@me/applications/${APP}/role-connection`;

async function store(h: Harness) {
  return new LinkedRolesContext(h.services, h.options).store();
}

/** A linked user as a completed browser flow leaves them, `ageSeconds` ago. */
async function linked(h: Harness, id: string, login: string, ageSeconds = 0) {
  expect((await link(h, id, login)).status).toBe(200);
  h.clock.advance(ageSeconds);
  h.providers.calls.length = 0;
  h.providers.roleConnections.clear();
}

function quiet() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("refreshLinkedUser (for the github module)", () => {
  it("pushes fresh facts and stores the rotated refresh tokens", async () => {
    const h = await harness();
    await linked(h, A, "alice", 3600);
    const before = await (await store(h)).get(A);
    h.providers.mergedPrs.set("alice", 5);
    h.providers.orgMembers.add("alice");

    const result = await refreshLinkedUser(h.services, "ALICE", h.options);
    expect(result).toEqual({
      status: "updated",
      discordId: A,
      githubLogin: "alice",
      metadata: { merged_prs: 5, org_member: true, maintainer: false, owner: false },
    });
    expect(h.providers.roleConnections.get(A)).toEqual({
      platform_name: "GitHub",
      platform_username: "alice",
      metadata: { merged_prs: "5", org_member: "1", maintainer: "0", owner: "0" },
    });
    const after = (await (await store(h)).get(A))!;
    expect(after.discordRefreshToken).not.toBe(before?.discordRefreshToken);
    expect(after.githubRefreshToken).not.toBe(before?.githubRefreshToken);
    expect(h.providers.discordRefresh.has(after.discordRefreshToken!)).toBe(true);
    expect(h.providers.githubRefresh.has(after.githubRefreshToken!)).toBe(true);
    expect(after.updatedAt).toBe(h.clock.seconds);
  });

  it("returns not-linked without any network call for an unknown login", async () => {
    const h = await harness();
    expect(await refreshLinkedUser(h.services, "nobody", h.options)).toEqual({ status: "not-linked", githubLogin: "nobody" });
    expect(h.providers.calls).toHaveLength(0);
  });

  it("deletes the user when they revoked the app on Discord", async () => {
    const h = await harness();
    await linked(h, A, "alice");
    h.providers.discordRefresh.clear();
    expect((await refreshLinkedUser(h.services, "alice", h.options)).status).toBe("revoked");
    expect(h.d1.row(A)).toBeUndefined();
    expect(h.providers.callsTo("PUT", PUT_PATH)).toHaveLength(0);
  });

  it("keeps the token and records the attempt when Discord fails transiently", async () => {
    const h = await harness();
    await linked(h, A, "alice", 100);
    const before = h.d1.row(A)!;
    h.providers.fail.add("POST discord.com/api/v10/oauth2/token");
    await expect(refreshLinkedUser(h.services, "alice", h.options)).rejects.toThrow(/discord token refresh failed with 500/);
    const after = h.d1.row(A)!;
    expect(after.discord_refresh_token).toBe(before.discord_refresh_token);
    expect(after.updated_at).toBe(h.clock.seconds);
  });

  it("unlinks GitHub when the user revoked it there, and pushes empty metadata", async () => {
    const h = await harness();
    h.providers.orgMembers.add("alice");
    await linked(h, A, "alice");
    h.providers.githubRefresh.clear();
    const result = await refreshLinkedUser(h.services, "alice", h.options);
    expect(result).toMatchObject({ status: "updated", githubLogin: null });
    expect(h.providers.roleConnections.get(A)).toEqual({
      platform_name: "GitHub",
      metadata: { merged_prs: "0", org_member: "0", maintainer: "0", owner: "0" },
    });
    expect(h.d1.row(A)).toMatchObject({ github_login: null, github_refresh_token: null });
    expect(h.providers.callsTo("GET", "api.github.com/search/issues")).toHaveLength(0);
  });

  it("falls back to the stored login when the GitHub token endpoint fails", async () => {
    const error = quiet();
    const h = await harness();
    h.providers.mergedPrs.set("alice", 2);
    await linked(h, A, "alice");
    const before = h.d1.row(A)!;
    h.providers.fail.add("POST github.com/login/oauth/access_token");
    expect(await refreshLinkedUser(h.services, "alice", h.options)).toMatchObject({ status: "updated", githubLogin: "alice" });
    expect(h.providers.roleConnections.get(A)?.metadata).toMatchObject({ merged_prs: "2" });
    expect(h.d1.row(A)?.github_refresh_token).toBe(before.github_refresh_token);
    expect(String(error.mock.calls[0]?.[0])).toContain("using the stored login");
  });

  it("follows a GitHub rename", async () => {
    const h = await harness();
    await linked(h, A, "alice");
    h.providers.renamed.set("alice", "alice-new");
    h.providers.mergedPrs.set("alice-new", 7);
    const result = await refreshLinkedUser(h.services, "alice", h.options);
    expect(result).toMatchObject({ status: "updated", githubLogin: "alice-new" });
    expect(h.providers.roleConnections.get(A)).toMatchObject({ platform_username: "alice-new", metadata: { merged_prs: "7" } });
    expect(h.d1.row(A)?.github_login).toBe("alice-new");
    const refreshed = (await (await store(h)).get(A))!;
    expect(h.providers.githubRefresh.has(refreshed.githubRefreshToken!)).toBe(true);
  });

  it("saves the rotated tokens even when the push fails", async () => {
    const h = await harness();
    await linked(h, A, "alice");
    h.providers.fail.add(`PUT ${PUT_PATH}`);
    await expect(refreshLinkedUser(h.services, "alice", h.options)).rejects.toThrow(/500/);
    const after = (await (await store(h)).get(A))!;
    expect(h.providers.discordRefresh.has(after.discordRefreshToken!)).toBe(true);
    expect(h.providers.githubRefresh.has(after.githubRefreshToken!)).toBe(true);
  });

  it("saves the rotated tokens even when GitHub facts fail", async () => {
    const h = await harness();
    await linked(h, A, "alice");
    h.providers.fail.add("GET api.github.com/search/issues");
    await expect(refreshLinkedUser(h.services, "alice", h.options)).rejects.toThrow(/search\/issues failed with 500/);
    const after = (await (await store(h)).get(A))!;
    expect(h.providers.discordRefresh.has(after.discordRefreshToken!)).toBe(true);
    expect(h.providers.callsTo("PUT", PUT_PATH)).toHaveLength(0);
  });
});

describe("cron refresh", () => {
  it("refreshes stale users oldest first, in batches, and continues past failures", async () => {
    const error = quiet();
    const h = await harness({}, { batchSize: 2, staleAfterSeconds: 1000 });
    await linked(h, A, "alice");
    await linked(h, B, "bob");
    await linked(h, C, "carol");
    const s = await store(h);
    // All three are stale, oldest A, then B, then C; the batch takes two.
    await s.update(A, {}, h.clock.seconds - 5000);
    await s.update(B, {}, h.clock.seconds - 4000);
    await s.update(C, {}, h.clock.seconds - 3000);

    h.providers.fail.add(`GET api.github.com/orgs/${ORG}/members/alice`);
    const summary = await refreshStale(new LinkedRolesContext(h.services, h.options));
    expect(summary).toEqual({ checked: 2, updated: 1, revoked: 0, noToken: 0, failed: 1 });
    expect([...h.providers.roleConnections.keys()]).toEqual([B]);
    expect(String(error.mock.calls[0]?.[0])).toContain(`refresh of ${A} failed`);
    // Both attempts moved to the back of the queue; C waits for the next run.
    expect(h.d1.row(A)?.updated_at).toBe(h.clock.seconds);
    expect(h.d1.row(B)?.updated_at).toBe(h.clock.seconds);
    expect((await s.stale(h.clock.seconds - 1000, 10)).map((u) => u.discordId)).toEqual([C]);
  });

  it("clears tokens that no longer decrypt and counts them", async () => {
    const h = await harness();
    await linked(h, A, "alice", 2 * 24 * 3600);
    h.d1.sqlite.exec(`UPDATE users SET discord_refresh_token = 'v1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' WHERE discord_id = '${A}'`);
    const summary = await refreshStale(new LinkedRolesContext(h.services, h.options));
    expect(summary).toMatchObject({ checked: 1, noToken: 1 });
    expect(h.d1.row(A)?.discord_refresh_token).toBeNull();
    expect(h.providers.calls).toHaveLength(0);
  });

  it("runs from the Worker's scheduled handler and logs a summary", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const h = await harness();
    await linked(h, A, "alice", 2 * 24 * 3600);
    await linked(h, B, "bob", 0);
    h.providers.discordRefresh.clear();
    await h.scheduled();
    expect(log).toHaveBeenCalledWith(
      "linked-roles refresh: 1 checked, 0 updated, 1 revoked, 0 without token, 0 failed",
    );
    // A was stale and had revoked the app; B linked just now and was not checked.
    expect(h.d1.row(A)).toBeUndefined();
    expect(h.d1.row(B)).toBeDefined();
  });
});
