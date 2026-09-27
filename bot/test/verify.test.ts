import { describe, expect, it } from "vitest";
import {
  MAX_INTERACTION_AGE_SECONDS,
  bytesToHex,
  hexToBytes,
  timingSafeEqual,
  verifyDiscordSignature,
  verifyGitHubSignature,
} from "../src/verify.ts";
import { ed25519Signer, githubSignature } from "./helpers.ts";

const encoder = new TextEncoder();

describe("hex helpers", () => {
  it("round-trips bytes", () => {
    const bytes = Uint8Array.of(0, 1, 127, 128, 255);
    expect(bytesToHex(bytes)).toBe("00017f80ff");
    expect(hexToBytes("00017F80ff")).toEqual(bytes);
  });

  it("rejects malformed hex", () => {
    expect(hexToBytes("")).toBeNull();
    expect(hexToBytes("abc")).toBeNull();
    expect(hexToBytes("zz")).toBeNull();
  });

  it("compares in constant structure", () => {
    expect(timingSafeEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3))).toBe(true);
    expect(timingSafeEqual(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 4))).toBe(false);
    expect(timingSafeEqual(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 3))).toBe(false);
  });
});

describe("verifyDiscordSignature", () => {
  const body = JSON.stringify({ type: 1 });
  const now = 1_800_000_000;
  const timestamp = String(now);

  it("accepts a valid signature", async () => {
    const signer = await ed25519Signer();
    const signatureHex = await signer.sign(timestamp, body);
    expect(
      await verifyDiscordSignature({ publicKeyHex: signer.publicKeyHex, signatureHex, timestamp, body, nowSeconds: now }),
    ).toBe(true);
  });

  it("rejects a changed body, a changed timestamp and another key", async () => {
    const signer = await ed25519Signer();
    const other = await ed25519Signer();
    const signatureHex = await signer.sign(timestamp, body);
    const base = { publicKeyHex: signer.publicKeyHex, signatureHex, timestamp, body, nowSeconds: now };
    expect(await verifyDiscordSignature({ ...base, body: body + " " })).toBe(false);
    expect(await verifyDiscordSignature({ ...base, timestamp: String(now + 1), nowSeconds: now })).toBe(false);
    expect(await verifyDiscordSignature({ ...base, publicKeyHex: other.publicKeyHex })).toBe(false);
  });

  it("rejects missing or malformed headers and keys", async () => {
    const signer = await ed25519Signer();
    const signatureHex = await signer.sign(timestamp, body);
    const base = { publicKeyHex: signer.publicKeyHex, signatureHex, timestamp, body, nowSeconds: now };
    expect(await verifyDiscordSignature({ ...base, signatureHex: null })).toBe(false);
    expect(await verifyDiscordSignature({ ...base, timestamp: null })).toBe(false);
    expect(await verifyDiscordSignature({ ...base, timestamp: "12a" })).toBe(false);
    expect(await verifyDiscordSignature({ ...base, signatureHex: "00".repeat(64) })).toBe(false);
    expect(await verifyDiscordSignature({ ...base, signatureHex: signatureHex.slice(2) })).toBe(false);
    expect(await verifyDiscordSignature({ ...base, signatureHex: "zz" + signatureHex.slice(2) })).toBe(false);
    expect(await verifyDiscordSignature({ ...base, publicKeyHex: "" })).toBe(false);
    expect(await verifyDiscordSignature({ ...base, publicKeyHex: "ab".repeat(31) })).toBe(false);
  });

  it("rejects a timestamp outside the replay window", async () => {
    const signer = await ed25519Signer();
    const old = String(now - MAX_INTERACTION_AGE_SECONDS - 1);
    const signatureHex = await signer.sign(old, body);
    expect(
      await verifyDiscordSignature({ publicKeyHex: signer.publicKeyHex, signatureHex, timestamp: old, body, nowSeconds: now }),
    ).toBe(false);
  });
});

describe("verifyGitHubSignature", () => {
  const secret = "It's a Secret to Everybody";
  const body = "Hello, World!";

  it("matches GitHub's documented example", async () => {
    // docs.github.com "Validating webhook deliveries" test values.
    const expected = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
    expect(await githubSignature(secret, body)).toBe(expected);
    expect(await verifyGitHubSignature(secret, expected, encoder.encode(body))).toBe(true);
  });

  it("rejects a wrong secret, changed body, missing prefix and bad length", async () => {
    const header = await githubSignature(secret, body);
    expect(await verifyGitHubSignature("other", header, encoder.encode(body))).toBe(false);
    expect(await verifyGitHubSignature(secret, header, encoder.encode(body + "!"))).toBe(false);
    expect(await verifyGitHubSignature(secret, header.slice("sha256=".length), encoder.encode(body))).toBe(false);
    expect(await verifyGitHubSignature(secret, header.slice(0, -2), encoder.encode(body))).toBe(false);
    expect(await verifyGitHubSignature(secret, null, encoder.encode(body))).toBe(false);
    expect(await verifyGitHubSignature("", header, encoder.encode(body))).toBe(false);
  });
});
