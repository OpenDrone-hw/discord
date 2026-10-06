/**
 * Early Bird: the role and #early-birds channel for OpenDrone preorder buyers.
 *
 * The storefront (opendrone.be/early-bird) decides who qualifies: a paid,
 * not cancelled preorder placed before the preorder run closes. It proves the
 * buyer through a signed-in account or the link in the order confirmation
 * mail, then sends the browser here with a claim token signed with the
 * EARLY_BIRD_CLAIM_KEY secret both Workers hold. This Worker runs the Discord
 * step, because its application holds the registered OAuth redirect.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant B as Browser
 *   participant S as opendrone.be
 *   participant W as Worker
 *   participant D as Discord
 *   B->>S: /early-bird (signed in, or mail link)
 *   S-->>B: 302 /early-bird?t=<claim token, 10 min>
 *   B->>W: GET /early-bird?t=
 *   W-->>B: 302 Discord authorize (identify guilds.join), cookie {step early-bird, order}
 *   B->>D: approve
 *   D-->>B: 302 /linked-roles/discord/callback?code&state
 *   B->>W: callback + cookie
 *   W->>W: D1 early_bird_claims: order -> Discord id, first claim wins
 *   W->>D: add to the server with the role, or add the role
 *   W-->>B: 200 done, link to #early-birds
 * ```
 *
 * One order unlocks the role for one Discord account (early_bird_claims has
 * the order as primary key); the same account may claim again, for example
 * after leaving the server, and gets the role back. The callback path is the
 * linked-roles one because it is the only redirect the application
 * registers; routes.ts hands the request here when the cookie's step is
 * "early-bird". The Discord grant is used once and no token is stored.
 *
 * Claim token: "v1." + base64url(JSON {o, n, exp}) + "." + base64url(HMAC-SHA256
 * of "v1." + the payload part). o: Shopify order GID, n: order name ("#1042"),
 * exp: Unix seconds.
 */
import { errorText } from "../interactions.ts";
import { timingSafeEqual } from "../verify.ts";
import type { LinkedRolesContext } from "./context.ts";
import { base64UrlDecode, randomToken } from "./crypto.ts";
import { discordLabel, OAuthError } from "./oauth.ts";
import { DISCORD_CALLBACK_PATH, page } from "./routes.ts";
import { clearedCookie, SESSION_TTL_SECONDS, sessionCookie, stateMatches, type Session } from "./session.ts";
import { base64UrlEncode } from "../github.ts";

export const EARLY_BIRD_PATH = "/early-bird";
export const EARLY_BIRD_SCOPES: readonly string[] = ["identify", "guilds.join"];
export const STOREFRONT_URL = "https://opendrone.be/early-bird";

const ORDER_GID = /^gid:\/\/shopify\/Order\/\d{1,20}$/;
const ORDER_NAME = /^#?[A-Za-z0-9-]{1,20}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface ClaimToken {
  orderId: string;
  orderName: string;
}

async function hmac(secret: string, text: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text)));
}

/** A claim token as the storefront builds it; the tests use it too. */
export async function signClaimToken(secret: string, claim: ClaimToken, exp: number): Promise<string> {
  const body = `v1.${base64UrlEncode(JSON.stringify({ o: claim.orderId, n: claim.orderName, exp }))}`;
  return `${body}.${base64UrlEncode(await hmac(secret, body))}`;
}

/** The claim, or null when the token is malformed, altered, signed with another key or expired. */
export async function verifyClaimToken(secret: string, token: string, nowSeconds: number): Promise<ClaimToken | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || !parts[1] || !parts[2]) return null;
  const given = base64UrlDecode(parts[2]);
  if (!given || !timingSafeEqual(given, await hmac(secret, `v1.${parts[1]}`))) return null;
  const raw = base64UrlDecode(parts[1]);
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(decoder.decode(raw));
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const { o, n, exp } = data as Record<string, unknown>;
  if (typeof o !== "string" || !ORDER_GID.test(o)) return null;
  if (typeof n !== "string" || !ORDER_NAME.test(n)) return null;
  if (typeof exp !== "number" || exp <= nowSeconds) return null;
  return { orderId: o, orderName: n };
}

/** D1 early_bird_claims. */
export class ClaimStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  /** Records the claim unless the order is claimed already; returns the Discord id that holds the order. */
  async claim(claim: ClaimToken, discordId: string, nowSeconds: number): Promise<string> {
    await this.#db
      .prepare(
        "INSERT INTO early_bird_claims (order_id, order_name, discord_id, claimed_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (order_id) DO NOTHING",
      )
      .bind(claim.orderId, claim.orderName, discordId, nowSeconds)
      .run();
    const row = await this.#db
      .prepare("SELECT discord_id FROM early_bird_claims WHERE order_id = ?1")
      .bind(claim.orderId)
      .first<{ discord_id: string }>();
    if (!row) throw new Error("early_bird_claims: row missing after insert");
    return row.discord_id;
  }
}

const AGAIN = { label: "Start again on opendrone.be", href: STOREFRONT_URL };

function expired(): Response {
  return page(400, "Link expired", ["This claim link is no longer valid. Claim links last 10 minutes.", AGAIN], clearedCookie());
}

/** GET /early-bird?t=<claim token>: start the Discord step for one order. */
export async function startEarlyBird(ctx: LinkedRolesContext, request: Request): Promise<Response> {
  const secret = ctx.env.EARLY_BIRD_CLAIM_KEY;
  if (!secret) return page(503, "Early Bird claims are closed", ["Claims are not set up on this server yet.", AGAIN]);
  const token = new URL(request.url).searchParams.get("t") ?? "";
  const claim = await verifyClaimToken(secret, token, ctx.nowSeconds());
  if (!claim) return expired();
  const origin = new URL(request.url).origin;
  const state = randomToken();
  const cookie = await sessionCookie(await ctx.sessionKey(), {
    step: "early-bird",
    state,
    exp: ctx.nowSeconds() + SESSION_TTL_SECONDS,
    orderId: claim.orderId,
    orderName: claim.orderName,
  });
  const headers = new Headers({
    Location: ctx.discord.authorizeUrl(origin + DISCORD_CALLBACK_PATH, state, EARLY_BIRD_SCOPES),
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 302, headers });
}

/** The Discord callback for a session in step "early-bird" (dispatched by routes.ts). */
export async function earlyBirdCallback(ctx: LinkedRolesContext, request: Request, session: Session): Promise<Response> {
  const url = new URL(request.url);
  if (!session.orderId || !session.orderName) return expired();
  if (!stateMatches(session.state, url.searchParams.get("state"))) return expired();
  if (url.searchParams.has("error")) {
    return page(400, "Discord authorization cancelled", ["Nothing changed.", AGAIN], clearedCookie());
  }
  const code = url.searchParams.get("code");
  const failed = () => page(400, "Discord authorization failed", ["Nothing changed.", AGAIN], clearedCookie());
  if (!code) return failed();

  let accessToken: string;
  try {
    accessToken = (await ctx.discord.exchangeCode(code, url.origin + DISCORD_CALLBACK_PATH, EARLY_BIRD_SCOPES)).accessToken;
  } catch (error) {
    if (!(error instanceof OAuthError)) throw error;
    console.error("early-bird: Discord code exchange failed:", errorText(error));
    return failed();
  }
  const user = await ctx.discord.currentUser(accessToken);
  const { discord, directory, env } = ctx.services;

  const roleId = await directory.roleId("earlyBird");
  if (!roleId) {
    console.error("early-bird: the Early Bird role does not exist on the server");
    return page(503, "Role not available", ["The Early Bird role is missing on the server. Nothing was claimed; try again later.", AGAIN], clearedCookie());
  }

  const claim = { orderId: session.orderId, orderName: session.orderName };
  const holder = await new ClaimStore(env.DB).claim(claim, user.id, ctx.nowSeconds());
  if (holder !== user.id) {
    return page(
      409,
      "Order already claimed",
      [
        `Order ${claim.orderName} already unlocked the Early Bird role for another Discord account. Each order unlocks it for one account.`,
        "If that was not you, open a ticket and name the order number.",
        { label: "Open a support ticket", href: "https://opendrone.be/support?topic=order" },
      ],
      clearedCookie(),
    );
  }

  const reason = `Early Bird claim, order ${claim.orderName}`;
  const added = await discord.addGuildMember(env.GUILD_ID, user.id, accessToken, [roleId], reason);
  if (added === null) await discord.addMemberRole(env.GUILD_ID, user.id, roleId, reason);

  const channelId = await directory.channelId("earlyBirds");
  const where = `https://discord.com/channels/${env.GUILD_ID}${channelId ? `/${channelId}` : ""}`;
  return page(
    200,
    "You are an Early Bird",
    [
      `${discordLabel(user)} now has the Early Bird role for order ${claim.orderName}${added === null ? "" : " and joined the OpenDrone server"}.`,
      "The role unlocks #early-birds. Thank you for backing OpenDrone.",
      { label: "Open #early-birds in Discord", href: where },
    ],
    clearedCookie(),
  );
}
