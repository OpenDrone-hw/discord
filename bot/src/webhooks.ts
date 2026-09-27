/**
 * POST /github: HMAC check, then every matching handler runs in waitUntil
 * after a 202 reply, because GitHub gives a delivery 10 s.
 */
import type { Env } from "./env.ts";
import { errorText } from "./interactions.ts";
import type { Registry } from "./registry.ts";
import type { Services } from "./services.ts";
import { verifyGitHubSignature } from "./verify.ts";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function handleGitHubWebhook(
  request: Request,
  env: Env,
  services: Services,
  registry: Registry,
): Promise<Response> {
  const body = new Uint8Array(await request.arrayBuffer());
  const valid = await verifyGitHubSignature(
    env.GITHUB_WEBHOOK_SECRET ?? "",
    request.headers.get("X-Hub-Signature-256"),
    body,
  );
  if (!valid) return new Response("invalid signature", { status: 401 });

  const event = request.headers.get("X-GitHub-Event");
  const delivery = request.headers.get("X-GitHub-Delivery");
  if (!event) return new Response("missing X-GitHub-Event", { status: 400 });
  if (event === "ping") return json({ ok: true }, 200);

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return new Response("invalid payload", { status: 400 });
  }
  const record = payload as Record<string, unknown>;
  const action = typeof record.action === "string" ? record.action : undefined;

  const handlers = registry.githubHandlers(event, action);
  for (const { module, handler } of handlers) {
    const run = async () => {
      try {
        await handler.handle({ event, action, delivery, payload: record, services });
      } catch (error) {
        console.error(`github ${event}.${action ?? "-"} delivery ${delivery ?? "?"} (${module}) failed:`, errorText(error));
      }
    };
    services.waitUntil(run());
  }
  return json({ ok: true, handlers: handlers.length }, 202);
}
