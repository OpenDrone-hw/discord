/**
 * GitHub App client.
 *
 * App authentication is an RS256 JWT signed with the App private key through
 * WebCrypto. The key is the PEM GitHub issues ("BEGIN RSA PRIVATE KEY", PKCS#1)
 * or its PKCS#8 form ("BEGIN PRIVATE KEY"); PKCS#1 is wrapped into PKCS#8
 * here because WebCrypto imports only PKCS#8. Installation tokens are cached
 * per isolate until five minutes before they expire.
 */
import type { FetchLike } from "./discord.ts";

export const GITHUB_API = "https://api.github.com";
export const GITHUB_USER_AGENT = "OpenDrone-hw-discord-bot";
const API_VERSION = "2022-11-28";

const encoder = new TextEncoder();

export function base64UrlEncode(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64Decode(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** DER length octets. */
export function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

// AlgorithmIdentifier { rsaEncryption (1.2.840.113549.1.1.1), NULL }
const RSA_ALGORITHM_IDENTIFIER = Uint8Array.of(
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
);

/** Wraps a PKCS#1 RSAPrivateKey into a PKCS#8 PrivateKeyInfo. */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const octetString = concat(Uint8Array.of(0x04), derLength(pkcs1.length), pkcs1);
  const content = concat(version, RSA_ALGORITHM_IDENTIFIER, octetString);
  return concat(Uint8Array.of(0x30), derLength(content.length), content);
}

export function parsePem(pem: string): { label: string; der: Uint8Array } {
  // Secrets pasted into a single line often carry literal "\n" sequences.
  const text = pem.replace(/\\n/g, "\n").trim();
  const match = /-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END \1-----/.exec(text);
  if (!match) throw new Error("GitHub App private key is not a PEM block");
  return { label: match[1] as string, der: base64Decode((match[2] as string).replace(/\s+/g, "")) };
}

export async function importAppPrivateKey(pem: string): Promise<CryptoKey> {
  const { label, der } = parsePem(pem);
  let pkcs8: Uint8Array;
  if (label === "PRIVATE KEY") pkcs8 = der;
  else if (label === "RSA PRIVATE KEY") pkcs8 = pkcs1ToPkcs8(der);
  else throw new Error(`GitHub App private key has unsupported PEM label ${label}`);
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

/**
 * JWT for authenticating as the App: iat 60 s in the past against clock
 * drift, exp 9 minutes ahead (GitHub allows at most 10).
 */
export async function createAppJwt(appId: string, key: CryptoKey, nowSeconds: number): Promise<string> {
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(signingInput));
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export class GitHubError extends Error {
  readonly status: number;
  readonly route: string;
  readonly body: unknown;

  constructor(status: number, route: string, body: unknown) {
    const detail =
      typeof body === "object" && body !== null && typeof (body as { message?: unknown }).message === "string"
        ? `: ${(body as { message: string }).message}`
        : "";
    super(`GitHub ${route} failed with ${status}${detail}`);
    this.name = "GitHubError";
    this.status = status;
    this.route = route;
    this.body = body;
  }
}

export interface GitHubRequestOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
}

/** One authenticated GitHub REST call. `authorization` is the full header value. */
export async function githubRequest<T = unknown>(
  fetchFn: FetchLike,
  authorization: string,
  method: string,
  path: string,
  options: GitHubRequestOptions = {},
  baseUrl = GITHUB_API,
): Promise<T> {
  const url = new URL(baseUrl + path);
  for (const [name, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(name, String(value));
  }
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    Authorization: authorization,
    "User-Agent": GITHUB_USER_AGENT,
    "X-GitHub-Api-Version": API_VERSION,
  };
  const init: RequestInit = { method: method.toUpperCase(), headers };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  const response = await fetchFn(url.toString(), init);
  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text.slice(0, 500);
    }
  }
  if (!response.ok) throw new GitHubError(response.status, `${init.method} ${path}`, data);
  return data as T;
}

export interface GitHubAppOptions {
  appId: string;
  privateKey: string;
  fetch?: FetchLike;
  /** Clock in milliseconds. */
  now?: () => number;
  baseUrl?: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export class GitHubApp {
  readonly appId: string;
  readonly #privateKey: string;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #baseUrl: string;
  #key: Promise<CryptoKey> | undefined;
  #jwt: CachedToken | undefined;
  readonly #installationTokens = new Map<string, CachedToken>();
  readonly #repoInstallations = new Map<string, string>();

  constructor(options: GitHubAppOptions) {
    this.appId = options.appId;
    this.#privateKey = options.privateKey;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#now = options.now ?? (() => Date.now());
    this.#baseUrl = options.baseUrl ?? GITHUB_API;
  }

  /** App JWT, reused until one minute before it expires. */
  async appJwt(): Promise<string> {
    const now = this.#now();
    if (this.#jwt && this.#jwt.expiresAt - 60_000 > now) return this.#jwt.token;
    this.#key ??= importAppPrivateKey(this.#privateKey);
    let key: CryptoKey;
    try {
      key = await this.#key;
    } catch (error) {
      this.#key = undefined;
      throw error;
    }
    const nowSeconds = Math.floor(now / 1000);
    const token = await createAppJwt(this.appId, key, nowSeconds);
    this.#jwt = { token, expiresAt: (nowSeconds + 540) * 1000 };
    return token;
  }

  /** Request authenticated as the App itself (installations, app metadata). */
  async appRequest<T = unknown>(method: string, path: string, options: GitHubRequestOptions = {}): Promise<T> {
    return githubRequest<T>(this.#fetch, `Bearer ${await this.appJwt()}`, method, path, options, this.#baseUrl);
  }

  async installationToken(installationId: string | number): Promise<string> {
    const id = String(installationId);
    const cached = this.#installationTokens.get(id);
    if (cached && cached.expiresAt - 300_000 > this.#now()) return cached.token;
    const result = await this.appRequest<{ token: string; expires_at: string }>(
      "POST",
      `/app/installations/${id}/access_tokens`,
    );
    const expiresAt = Date.parse(result.expires_at);
    this.#installationTokens.set(id, {
      token: result.token,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : this.#now() + 3_600_000,
    });
    return result.token;
  }

  /**
   * Request as an installation. A 401 drops the cached token and retries once,
   * which covers a token revoked before its expiry.
   */
  async request<T = unknown>(
    installationId: string | number,
    method: string,
    path: string,
    options: GitHubRequestOptions = {},
  ): Promise<T> {
    const call = async () =>
      githubRequest<T>(
        this.#fetch,
        `Bearer ${await this.installationToken(installationId)}`,
        method,
        path,
        options,
        this.#baseUrl,
      );
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 401) throw error;
      this.#installationTokens.delete(String(installationId));
      return call();
    }
  }

  /** Installation id for a repository, for calls not triggered by a webhook. */
  async installationForRepo(owner: string, repo: string): Promise<string> {
    const key = `${owner}/${repo}`.toLowerCase();
    const cached = this.#repoInstallations.get(key);
    if (cached) return cached;
    const result = await this.appRequest<{ id: number }>("GET", `/repos/${owner}/${repo}/installation`);
    const id = String(result.id);
    this.#repoInstallations.set(key, id);
    return id;
  }
}
