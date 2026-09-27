import { describe, expect, it } from "vitest";
import { TOKEN_KEY_INFO, deriveKey } from "../../src/linked-roles/crypto.ts";
import { UserStore } from "../../src/linked-roles/store.ts";
import { fakeD1 } from "./harness.ts";

const A = "111111111111111111";
const B = "222222222222222222";
const C = "333333333333333333";

async function setup(secret = "secret") {
  const d1 = fakeD1();
  const store = new UserStore(d1.db, await deriveKey(secret, TOKEN_KEY_INFO));
  return { d1, store };
}

describe("UserStore", () => {
  it("stores refresh tokens only as ciphertext", async () => {
    const { d1, store } = await setup();
    await store.saveDiscord(A, "discord-refresh-plain", 100);
    await store.linkGitHub(A, "Alice", "github-refresh-plain", 101);
    const raw = d1.row(A)!;
    expect(String(raw.discord_refresh_token)).toMatch(/^v1\./);
    expect(String(raw.github_refresh_token)).toMatch(/^v1\./);
    expect(JSON.stringify(raw)).not.toContain("refresh-plain");
    expect(await store.get(A)).toEqual({
      discordId: A,
      githubLogin: "Alice",
      discordRefreshToken: "discord-refresh-plain",
      githubRefreshToken: "github-refresh-plain",
      updatedAt: 101,
      owner: false,
    });
  });

  it("finds users by GitHub login case-insensitively", async () => {
    const { store } = await setup();
    await store.saveDiscord(A, "r", 1);
    await store.linkGitHub(A, "Alice", null, 2);
    expect((await store.getByGitHubLogin("aLiCe"))?.discordId).toBe(A);
    expect(await store.getByGitHubLogin("bob")).toBeNull();
  });

  it("moves a GitHub login to the newest Discord account and queues the old one", async () => {
    const { d1, store } = await setup();
    await store.saveDiscord(A, "ra", 1);
    await store.linkGitHub(A, "alice", "ga", 2);
    await store.saveDiscord(B, "rb", 3);
    expect(await store.linkGitHub(B, "ALICE", "gb", 4)).toEqual([A]);
    expect(d1.row(A)).toMatchObject({ github_login: null, github_refresh_token: null, updated_at: 0 });
    expect((await store.get(A))?.discordRefreshToken).toBe("ra");
    expect((await store.getByGitHubLogin("alice"))?.discordId).toBe(B);
    // Relinking the same account to the same login detaches nobody.
    expect(await store.linkGitHub(B, "alice", "gb2", 5)).toEqual([]);
  });

  it("creates the row if the GitHub step arrives without one", async () => {
    const { store } = await setup();
    await store.linkGitHub(C, "carol", null, 9);
    expect(await store.get(C)).toMatchObject({ githubLogin: "carol", discordRefreshToken: null, updatedAt: 9 });
  });

  it("updates only the given fields", async () => {
    const { store } = await setup();
    await store.saveDiscord(A, "r1", 1);
    await store.linkGitHub(A, "alice", "g1", 2);
    await store.update(A, { discordRefreshToken: "r2" }, 3);
    expect(await store.get(A)).toMatchObject({ discordRefreshToken: "r2", githubRefreshToken: "g1", githubLogin: "alice", updatedAt: 3 });
    await store.update(A, { githubRefreshToken: null, githubLogin: null }, 4);
    expect(await store.get(A)).toMatchObject({ discordRefreshToken: "r2", githubRefreshToken: null, githubLogin: null, updatedAt: 4 });
    await store.update(A, {}, 5);
    expect((await store.get(A))?.updatedAt).toBe(5);
  });

  it("reads a token copied to another row, or sealed under another secret, as null", async () => {
    const { d1, store } = await setup();
    await store.saveDiscord(A, "ra", 1);
    await store.saveDiscord(B, "rb", 1);
    d1.sqlite.exec(
      `UPDATE users SET discord_refresh_token = (SELECT discord_refresh_token FROM users WHERE discord_id = '${A}') WHERE discord_id = '${B}'`,
    );
    expect((await store.get(B))?.discordRefreshToken).toBeNull();
    const rotated = new UserStore(d1.db, await deriveKey("new-secret", TOKEN_KEY_INFO));
    expect((await rotated.get(A))?.discordRefreshToken).toBeNull();
  });

  it("lists stale users oldest first, with a limit, skipping users without a Discord token", async () => {
    const { store } = await setup();
    await store.saveDiscord(A, "ra", 50);
    await store.saveDiscord(B, "rb", 10);
    await store.saveDiscord(C, "rc", 30);
    await store.linkGitHub("444444444444444444", "dave", null, 0);
    expect((await store.stale(100, 10)).map((u) => u.discordId)).toEqual([B, C, A]);
    expect((await store.stale(100, 2)).map((u) => u.discordId)).toEqual([B, C]);
    expect((await store.stale(30, 10)).map((u) => u.discordId)).toEqual([B]);
  });

  it("reads the storefront's owner flag and deletes rows", async () => {
    const { d1, store } = await setup();
    await store.saveDiscord(A, "ra", 1);
    d1.sqlite.exec(`UPDATE users SET owner = 1 WHERE discord_id = '${A}'`);
    expect((await store.get(A))?.owner).toBe(true);
    await store.update(A, { discordRefreshToken: "rb" }, 2);
    expect(d1.row(A)?.owner).toBe(1);
    await store.delete(A);
    expect(await store.get(A)).toBeNull();
  });
});
