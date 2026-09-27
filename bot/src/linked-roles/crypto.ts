/**
 * Keys derived from SESSION_SECRET and the two things they protect.
 *
 * | Key (HKDF-SHA256 info)          | Algorithm   | Protects                                   |
 * |---------------------------------|-------------|--------------------------------------------|
 * | "linked-roles session v1"       | AES-256-GCM | The OAuth session cookie (state, step)     |
 * | "linked-roles refresh tokens v1"| AES-256-GCM | Refresh tokens stored in D1                |
 *
 * AES-GCM authenticates as well as encrypts: a value altered or built without
 * the secret fails to decrypt, so the cookie is signed and its contents stay
 * private. Every ciphertext is bound to a context string through the GCM
 * additional data (the cookie name, or "<discord id>/<column>" for a token),
 * so a ciphertext copied to another row, column or purpose does not decrypt.
 *
 * Format: "v1." + base64url(12-byte IV || ciphertext || 16-byte tag).
 * Rotating SESSION_SECRET makes every stored token unreadable; affected users
 * are dropped from the refresh and must link again.
 */
import { base64UrlEncode } from "../github.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SALT = encoder.encode("OpenDrone-hw/discord linked roles");
const PREFIX = "v1.";

export const SESSION_KEY_INFO = "linked-roles session v1";
export const TOKEN_KEY_INFO = "linked-roles refresh tokens v1";

export function base64UrlDecode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  try {
    const binary = atob(b64);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const keyCache = new Map<string, Promise<CryptoKey>>();

/** AES-256-GCM key for one purpose, derived from the secret with HKDF-SHA256. */
export function deriveKey(secret: string, info: string): Promise<CryptoKey> {
  if (!secret) return Promise.reject(new Error("SESSION_SECRET is not set"));
  const cacheKey = `${info}\u0000${secret}`;
  let key = keyCache.get(cacheKey);
  if (!key) {
    key = (async () => {
      const base = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
      return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: SALT, info: encoder.encode(info) },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    keyCache.set(cacheKey, key);
    key.catch(() => keyCache.delete(cacheKey));
  }
  return key;
}

export async function seal(key: CryptoKey, plaintext: string, context: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
      key,
      encoder.encode(plaintext),
    ),
  );
  const out = new Uint8Array(iv.length + ciphertext.length);
  out.set(iv);
  out.set(ciphertext, iv.length);
  return PREFIX + base64UrlEncode(out);
}

/** Plaintext, or null when the value is malformed, altered, or sealed for another context or key. */
export async function open(key: CryptoKey, sealed: string, context: string): Promise<string | null> {
  if (!sealed.startsWith(PREFIX)) return null;
  const bytes = base64UrlDecode(sealed.slice(PREFIX.length));
  if (!bytes || bytes.length < 12 + 16) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: encoder.encode(context) },
      key,
      bytes.slice(12),
    );
    return decoder.decode(plaintext);
  } catch {
    return null;
  }
}

/** 32 random bytes, base64url: OAuth state values. */
export function randomToken(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}
