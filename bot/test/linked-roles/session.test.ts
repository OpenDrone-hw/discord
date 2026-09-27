import { describe, expect, it } from "vitest";
import { SESSION_KEY_INFO, deriveKey } from "../../src/linked-roles/crypto.ts";
import {
  COOKIE_NAME,
  clearedCookie,
  cookieValue,
  readSession,
  sessionCookie,
  stateMatches,
} from "../../src/linked-roles/session.ts";

const NOW = 1_800_000_000;

function requestWith(cookie: string | null): Request {
  return new Request("https://bot.example/linked-roles/discord/callback", cookie ? { headers: { Cookie: cookie } } : {});
}

describe("session cookie", () => {
  it("sets secure, host-only, short-lived attributes and hides its content", async () => {
    const key = await deriveKey("s", SESSION_KEY_INFO);
    const cookie = await sessionCookie(key, { step: "github", state: "st", exp: NOW + 600, discordAccessToken: "dat-secret" });
    expect(cookie.startsWith(`${COOKIE_NAME}=v1.`)).toBe(true);
    for (const attr of ["Max-Age=600", "Path=/", "Secure", "HttpOnly", "SameSite=Lax"]) expect(cookie).toContain(attr);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(cookie).not.toContain("dat-secret");
    expect(clearedCookie()).toContain("Max-Age=0");
  });

  it("reads back a valid session for the right step only", async () => {
    const key = await deriveKey("s", SESSION_KEY_INFO);
    const cookie = (await sessionCookie(key, { step: "github", state: "st", exp: NOW + 600, discordId: "123456789012345678" })).split(";")[0]!;
    expect(await readSession(key, requestWith(`other=1; ${cookie}`), "github", NOW)).toEqual({
      step: "github",
      state: "st",
      exp: NOW + 600,
      discordId: "123456789012345678",
    });
    expect(await readSession(key, requestWith(cookie), "discord", NOW)).toBeNull();
  });

  it("refuses expired, missing, altered and foreign cookies", async () => {
    const key = await deriveKey("s", SESSION_KEY_INFO);
    const cookie = (await sessionCookie(key, { step: "discord", state: "st", exp: NOW + 600 })).split(";")[0]!;
    expect(await readSession(key, requestWith(cookie), "discord", NOW + 600)).toBeNull();
    expect(await readSession(key, requestWith(null), "discord", NOW)).toBeNull();
    expect(await readSession(key, requestWith(`${cookie}x`), "discord", NOW)).toBeNull();
    expect(await readSession(key, requestWith(`${COOKIE_NAME}=v1.AAAA`), "discord", NOW)).toBeNull();
    const otherKey = await deriveKey("different", SESSION_KEY_INFO);
    expect(await readSession(otherKey, requestWith(cookie), "discord", NOW)).toBeNull();
  });

  it("parses cookie headers", () => {
    expect(cookieValue("a=1; b=two=2;c=3", "b")).toBe("two=2");
    expect(cookieValue("a=1", "b")).toBeNull();
    expect(cookieValue(null, "a")).toBeNull();
    expect(cookieValue("junk; a = 5 ", "a")).toBe("5");
  });

  it("compares state exactly", () => {
    expect(stateMatches("abc", "abc")).toBe(true);
    expect(stateMatches("abc", "abd")).toBe(false);
    expect(stateMatches("abc", "ab")).toBe(false);
    expect(stateMatches("abc", null)).toBe(false);
    expect(stateMatches("abc", "")).toBe(false);
  });
});
