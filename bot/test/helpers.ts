import type { Env } from "../src/env.ts";
import { bytesToHex, hmacSha256 } from "../src/verify.ts";

const encoder = new TextEncoder();

export interface Ed25519Signer {
  publicKeyHex: string;
  sign(timestamp: string, body: string): Promise<string>;
}

export async function ed25519Signer(): Promise<Ed25519Signer> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  return {
    publicKeyHex: bytesToHex(raw),
    async sign(timestamp, body) {
      const signature = await crypto.subtle.sign("Ed25519", pair.privateKey, encoder.encode(timestamp + body));
      return bytesToHex(new Uint8Array(signature));
    },
  };
}

export async function githubSignature(secret: string, body: string): Promise<string> {
  return `sha256=${bytesToHex(await hmacSha256(secret, encoder.encode(body)))}`;
}

export function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

export const BOT_TOKEN = "test-bot-token-value-that-must-never-leak";

export function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DISCORD_PUBLIC_KEY: "",
    DISCORD_BOT_TOKEN: BOT_TOKEN,
    DISCORD_CLIENT_ID: "client",
    DISCORD_CLIENT_SECRET: "client-secret",
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: "",
    GITHUB_WEBHOOK_SECRET: "webhook-secret",
    GITHUB_OAUTH_CLIENT_ID: "gh-client",
    GITHUB_OAUTH_CLIENT_SECRET: "gh-client-secret",
    SESSION_SECRET: "session-secret",
    DB: {} as D1Database,
    GUILD_ID: "1494019459822653512",
    APPLICATION_ID: "1553826696673759344",
    PROMOTE_ENABLED: "false",
    ...overrides,
  };
}

export interface FakeContext {
  ctx: ExecutionContext;
  pending: Promise<unknown>[];
  /** Waits for everything passed to waitUntil, including work it scheduled. */
  settle(): Promise<void>;
}

export function fakeContext(): FakeContext {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  return {
    ctx,
    pending,
    async settle() {
      let seen = 0;
      while (seen < pending.length) {
        const batch = pending.slice(seen);
        seen = pending.length;
        await Promise.allSettled(batch);
      }
    },
  };
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** fetch stand-in: records calls and answers from `respond`. */
export function mockFetch(respond: (call: RecordedCall, index: number) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fn = async (url: string, init: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: RecordedCall = {
      url,
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  };
  return { fetch: fn, calls };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
