/**
 * Request authentication for the two inbound webhooks.
 *
 * Discord interactions: Ed25519 signature over `timestamp + body`, sent as
 * X-Signature-Ed25519 (hex) and X-Signature-Timestamp. A failed check must be
 * answered with 401; Discord probes the endpoint with bad signatures.
 *
 * GitHub webhooks: X-Hub-Signature-256 = "sha256=" + hex HMAC-SHA256 of the raw
 * body, keyed with the webhook secret.
 */

const encoder = new TextEncoder();

/** Maximum age of an interaction timestamp, against replayed requests. */
export const MAX_INTERACTION_AGE_SECONDS = 300;

export function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** Compares two byte arrays in time that depends only on their length. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

const ed25519Keys = new Map<string, Promise<CryptoKey>>();

function importEd25519(publicKeyHex: string, raw: Uint8Array): Promise<CryptoKey> {
  let key = ed25519Keys.get(publicKeyHex);
  if (!key) {
    key = crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    ed25519Keys.set(publicKeyHex, key);
    key.catch(() => ed25519Keys.delete(publicKeyHex));
  }
  return key;
}

export interface DiscordSignatureInput {
  publicKeyHex: string;
  signatureHex: string | null;
  timestamp: string | null;
  body: string;
  /** Current time in seconds; defaults to the wall clock. */
  nowSeconds?: number;
}

export async function verifyDiscordSignature(input: DiscordSignatureInput): Promise<boolean> {
  const { publicKeyHex, signatureHex, timestamp, body } = input;
  if (!signatureHex || !timestamp || !/^\d+$/.test(timestamp)) return false;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > MAX_INTERACTION_AGE_SECONDS) return false;
  const signature = hexToBytes(signatureHex);
  const publicKey = hexToBytes(publicKeyHex);
  if (!signature || signature.length !== 64 || !publicKey || publicKey.length !== 32) return false;
  try {
    const key = await importEd25519(publicKeyHex, publicKey);
    return await crypto.subtle.verify("Ed25519", key, signature, encoder.encode(timestamp + body));
  } catch {
    return false;
  }
}

export async function hmacSha256(secret: string, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}

export async function verifyGitHubSignature(
  secret: string,
  header: string | null,
  body: Uint8Array,
): Promise<boolean> {
  if (!secret || !header || !header.startsWith("sha256=")) return false;
  const given = hexToBytes(header.slice("sha256=".length));
  if (!given || given.length !== 32) return false;
  const expected = await hmacSha256(secret, body);
  return timingSafeEqual(given, expected);
}
