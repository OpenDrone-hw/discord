import { describe, expect, it } from "vitest";
import {
  SESSION_KEY_INFO,
  TOKEN_KEY_INFO,
  base64UrlDecode,
  deriveKey,
  open,
  randomToken,
  seal,
} from "../../src/linked-roles/crypto.ts";

describe("linked-roles crypto", () => {
  it("round-trips a value sealed for a context", async () => {
    const key = await deriveKey("secret-a", TOKEN_KEY_INFO);
    const sealed = await seal(key, "refresh-token-value", "123/discord_refresh_token");
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("refresh-token-value");
    expect(await open(key, sealed, "123/discord_refresh_token")).toBe("refresh-token-value");
  });

  it("uses a fresh IV for every seal", async () => {
    const key = await deriveKey("secret-a", TOKEN_KEY_INFO);
    const a = await seal(key, "same", "ctx");
    const b = await seal(key, "same", "ctx");
    expect(a).not.toBe(b);
  });

  it("refuses another context, another secret and another purpose", async () => {
    const key = await deriveKey("secret-a", TOKEN_KEY_INFO);
    const sealed = await seal(key, "value", "123/discord_refresh_token");
    expect(await open(key, sealed, "456/discord_refresh_token")).toBeNull();
    expect(await open(key, sealed, "123/github_refresh_token")).toBeNull();
    expect(await open(await deriveKey("secret-b", TOKEN_KEY_INFO), sealed, "123/discord_refresh_token")).toBeNull();
    expect(await open(await deriveKey("secret-a", SESSION_KEY_INFO), sealed, "123/discord_refresh_token")).toBeNull();
  });

  it("refuses altered and malformed values", async () => {
    const key = await deriveKey("secret-a", TOKEN_KEY_INFO);
    const sealed = await seal(key, "value", "ctx");
    const body = sealed.slice(3);
    const flipped = body.slice(0, 20) + (body[20] === "A" ? "B" : "A") + body.slice(21);
    expect(await open(key, `v1.${flipped}`, "ctx")).toBeNull();
    expect(await open(key, sealed.slice(0, -2), "ctx")).toBeNull();
    for (const bad of ["", "v1.", "v2." + body, "v1.!!!", "v1.AAAA", body]) {
      expect(await open(key, bad, "ctx")).toBeNull();
    }
  });

  it("rejects an empty secret", async () => {
    await expect(deriveKey("", TOKEN_KEY_INFO)).rejects.toThrow(/SESSION_SECRET/);
  });

  it("makes 32-byte base64url random tokens", () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(base64UrlDecode(a)).toHaveLength(32);
    expect(randomToken()).not.toBe(a);
    expect(base64UrlDecode("a+b")).toBeNull();
  });
});
