/**
 * The OAuth session cookie. It carries the expected `state` of the provider
 * step in progress, which binds each callback to the browser that started the
 * flow (CSRF protection), and after the Discord step the Discord user id,
 * access token and account name needed to finish. The value is sealed with AES-GCM under the
 * session key (crypto.ts), so it is both signed and unreadable to the client.
 *
 * Attributes: __Host- prefix (Secure, Path=/, no Domain), HttpOnly,
 * SameSite=Lax (sent on the top-level redirect back from Discord or GitHub),
 * ten minute lifetime.
 */
import { timingSafeEqual } from "../verify.ts";
import { open, seal } from "./crypto.ts";

export const COOKIE_NAME = "__Host-linked-roles";
export const SESSION_TTL_SECONDS = 600;

export type SessionStep = "discord" | "github" | "early-bird";

export interface Session {
  step: SessionStep;
  state: string;
  /** Unix seconds. */
  exp: number;
  discordId?: string;
  discordAccessToken?: string;
  /** How the result page names the Discord account (discordLabel in oauth.ts). */
  discordName?: string;
  /** Early Bird step: the Shopify order the claim token names (early-bird.ts). */
  orderId?: string;
  orderName?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function sessionCookie(key: CryptoKey, session: Session): Promise<string> {
  const value = await seal(key, JSON.stringify(session), COOKIE_NAME);
  return `${COOKIE_NAME}=${value}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export function clearedCookie(): string {
  return `${COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

/** The session for `step`, or null when the cookie is missing, altered, expired or for another step. */
export async function readSession(
  key: CryptoKey,
  request: Request,
  step: SessionStep,
  nowSeconds: number,
): Promise<Session | null> {
  const raw = cookieValue(request.headers.get("Cookie"), COOKIE_NAME);
  if (!raw) return null;
  const text = await open(key, raw, COOKIE_NAME);
  if (text === null) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(data) || data.step !== step || typeof data.state !== "string" || typeof data.exp !== "number") {
    return null;
  }
  if (data.exp <= nowSeconds) return null;
  const session: Session = { step, state: data.state, exp: data.exp };
  if (typeof data.discordId === "string") session.discordId = data.discordId;
  if (typeof data.discordAccessToken === "string") session.discordAccessToken = data.discordAccessToken;
  if (typeof data.discordName === "string") session.discordName = data.discordName;
  if (typeof data.orderId === "string") session.orderId = data.orderId;
  if (typeof data.orderName === "string") session.orderName = data.orderName;
  return session;
}

const encoder = new TextEncoder();

export function stateMatches(expected: string, given: string | null): boolean {
  if (!given) return false;
  return timingSafeEqual(encoder.encode(expected), encoder.encode(given));
}
