import { describe, expect, it } from "vitest";
import {
  GitHubApp,
  GitHubError,
  base64UrlEncode,
  createAppJwt,
  derLength,
  importAppPrivateKey,
  parsePem,
  pkcs1ToPkcs8,
} from "../src/github.ts";
import { jsonResponse, mockFetch } from "./helpers.ts";

const encoder = new TextEncoder();

function toPem(label: string, der: Uint8Array): string {
  let binary = "";
  for (const b of der) binary += String.fromCharCode(b);
  const lines = btoa(binary).match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

function base64UrlDecode(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(b64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** Reads one DER TLV header; returns [contentStart, contentLength]. */
function tlv(der: Uint8Array, offset: number): [number, number] {
  const first = der[offset + 1] as number;
  if (first < 0x80) return [offset + 2, first];
  const count = first & 0x7f;
  let length = 0;
  for (let i = 0; i < count; i++) length = length * 256 + (der[offset + 2 + i] as number);
  return [offset + 2 + count, length];
}

/** Extracts the PKCS#1 RSAPrivateKey from a PKCS#8 PrivateKeyInfo. */
function pkcs8ToPkcs1(pkcs8: Uint8Array): Uint8Array {
  const [seqStart] = tlv(pkcs8, 0);
  const [versionStart, versionLength] = tlv(pkcs8, seqStart);
  const algOffset = versionStart + versionLength;
  const [algStart, algLength] = tlv(pkcs8, algOffset);
  const octetOffset = algStart + algLength;
  const [keyStart, keyLength] = tlv(pkcs8, octetOffset);
  return pkcs8.slice(keyStart, keyStart + keyLength);
}

async function rsaKeys() {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  return { publicKey: pair.publicKey, pkcs8, pkcs8Pem: toPem("PRIVATE KEY", pkcs8), pkcs1Pem: toPem("RSA PRIVATE KEY", pkcs8ToPkcs1(pkcs8)) };
}

async function verifyJwt(jwt: string, publicKey: CryptoKey): Promise<{ header: unknown; payload: Record<string, number | string> }> {
  const [header, payload, signature] = jwt.split(".");
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    base64UrlDecode(signature ?? ""),
    encoder.encode(`${header}.${payload}`),
  );
  expect(ok).toBe(true);
  return {
    header: JSON.parse(new TextDecoder().decode(base64UrlDecode(header ?? ""))),
    payload: JSON.parse(new TextDecoder().decode(base64UrlDecode(payload ?? ""))),
  };
}

describe("encoding helpers", () => {
  it("base64url-encodes without padding", () => {
    expect(base64UrlEncode(Uint8Array.of(0xfb, 0xff))).toBe("-_8");
    expect(base64UrlEncode("{}")).toBe("e30");
  });

  it("encodes DER lengths", () => {
    expect([...derLength(5)]).toEqual([5]);
    expect([...derLength(0x7f)]).toEqual([0x7f]);
    expect([...derLength(0x80)]).toEqual([0x81, 0x80]);
    expect([...derLength(1190)]).toEqual([0x82, 0x04, 0xa6]);
  });

  it("parses PEM, including single-line secrets with literal \\n", () => {
    const pem = toPem("PRIVATE KEY", Uint8Array.of(1, 2, 3));
    expect(parsePem(pem)).toEqual({ label: "PRIVATE KEY", der: Uint8Array.of(1, 2, 3) });
    expect(parsePem(pem.replace(/\n/g, "\\n")).der).toEqual(Uint8Array.of(1, 2, 3));
    expect(() => parsePem("not a key")).toThrow(/not a PEM/);
  });
});

describe("App JWT", () => {
  it("wraps PKCS#1 into the same PKCS#8 WebCrypto exports", async () => {
    const keys = await rsaKeys();
    expect(pkcs1ToPkcs8(pkcs8ToPkcs1(keys.pkcs8))).toEqual(keys.pkcs8);
  });

  it("signs RS256 with PKCS#8 and PKCS#1 keys", async () => {
    const keys = await rsaKeys();
    for (const pem of [keys.pkcs8Pem, keys.pkcs1Pem]) {
      const key = await importAppPrivateKey(pem);
      const jwt = await createAppJwt("12345", key, 1_800_000_000);
      const { header, payload } = await verifyJwt(jwt, keys.publicKey);
      expect(header).toEqual({ alg: "RS256", typ: "JWT" });
      expect(payload).toEqual({ iat: 1_800_000_000 - 60, exp: 1_800_000_000 + 540, iss: "12345" });
    }
  });

  it("rejects an unsupported key type", async () => {
    await expect(importAppPrivateKey(toPem("EC PRIVATE KEY", Uint8Array.of(1)))).rejects.toThrow(/unsupported PEM label/);
  });
});

describe("GitHubApp", () => {
  it("caches the JWT and installation token, and refreshes them near expiry", async () => {
    const keys = await rsaKeys();
    let now = Date.parse("2026-09-27T12:00:00Z");
    const { fetch, calls } = mockFetch((call) => {
      if (call.url.endsWith("/access_tokens")) {
        return jsonResponse({ token: `ghs_${calls.length}`, expires_at: new Date(now + 3_600_000).toISOString() }, 201);
      }
      return jsonResponse({ ok: true });
    });
    const app = new GitHubApp({ appId: "12345", privateKey: keys.pkcs1Pem, fetch, now: () => now });

    await app.request(77, "GET", "/repos/OpenDrone-hw/OpenRX/pulls");
    await app.request(77, "GET", "/repos/OpenDrone-hw/OpenRX/pulls/1");
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "POST /app/installations/77/access_tokens",
      "GET /repos/OpenDrone-hw/OpenRX/pulls",
      "GET /repos/OpenDrone-hw/OpenRX/pulls/1",
    ]);
    const jwt = calls[0]?.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const { payload } = await verifyJwt(jwt, keys.publicKey);
    expect(payload.iss).toBe("12345");
    expect(calls[1]?.headers.authorization).toBe("Bearer ghs_1");
    expect(calls[1]?.headers.accept).toBe("application/vnd.github+json");
    expect(calls[1]?.headers["x-github-api-version"]).toBe("2022-11-28");
    expect(calls[1]?.headers["user-agent"]).toBeTruthy();

    now += 56 * 60_000; // inside the five-minute refresh margin
    await app.request(77, "GET", "/repos/OpenDrone-hw/OpenRX");
    expect(calls[3]?.url).toMatch(/\/app\/installations\/77\/access_tokens$/);
    const secondJwt = calls[3]?.headers.authorization?.replace(/^Bearer /, "") ?? "";
    expect(secondJwt).not.toBe(jwt);
    expect(calls[4]?.headers.authorization).toBe("Bearer ghs_4");
  });

  it("retries once with a new token after a 401", async () => {
    const keys = await rsaKeys();
    let repoCalls = 0;
    const { fetch, calls } = mockFetch((call) => {
      if (call.url.endsWith("/access_tokens")) {
        return jsonResponse({ token: `ghs_${calls.length}`, expires_at: "2099-01-01T00:00:00Z" }, 201);
      }
      repoCalls += 1;
      return repoCalls === 1 ? jsonResponse({ message: "Bad credentials" }, 401) : jsonResponse({ ok: true });
    });
    const app = new GitHubApp({ appId: "1", privateKey: keys.pkcs8Pem, fetch });
    expect(await app.request("9", "GET", "/repos/OpenDrone-hw/OpenRX")).toEqual({ ok: true });
    expect(calls.filter((c) => c.url.endsWith("/access_tokens"))).toHaveLength(2);
  });

  it("sends JSON bodies and raises GitHubError", async () => {
    const keys = await rsaKeys();
    const { fetch, calls } = mockFetch((call) =>
      call.url.endsWith("/access_tokens")
        ? jsonResponse({ token: "ghs_x", expires_at: "2099-01-01T00:00:00Z" }, 201)
        : jsonResponse({ message: "Validation Failed" }, 422),
    );
    const app = new GitHubApp({ appId: "1", privateKey: keys.pkcs8Pem, fetch });
    const error = await app
      .request(1, "POST", "/repos/OpenDrone-hw/OpenRX/issues/3/comments", { body: { body: "hi" } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).status).toBe(422);
    expect((error as GitHubError).message).toContain("Validation Failed");
    expect((error as GitHubError).message).not.toContain("ghs_x");
    expect(calls[1]?.body).toEqual({ body: "hi" });
    expect(calls[1]?.headers["content-type"]).toBe("application/json");
  });

  it("looks up and caches a repository's installation", async () => {
    const keys = await rsaKeys();
    const { fetch, calls } = mockFetch(() => jsonResponse({ id: 4242 }));
    const app = new GitHubApp({ appId: "1", privateKey: keys.pkcs8Pem, fetch });
    expect(await app.installationForRepo("OpenDrone-hw", "OpenRX")).toBe("4242");
    expect(await app.installationForRepo("opendrone-hw", "openrx")).toBe("4242");
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/repos/OpenDrone-hw/OpenRX/installation");
  });
});
