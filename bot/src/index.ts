/**
 * Worker entry point.
 *
 * | Route                                 | Handler                         |
 * |---------------------------------------|---------------------------------|
 * | POST /interactions                    | interactions.ts (Ed25519)       |
 * | POST /github                          | webhooks.ts (HMAC-SHA256)       |
 * | GET /linked-roles                     | linked-roles module             |
 * | GET /linked-roles/discord/callback    | linked-roles module             |
 * | GET /linked-roles/github/callback     | linked-roles module             |
 * | scheduled() (cron in wrangler.toml)   | every module's scheduled()      |
 *
 * Anything else is 404; a known path with the wrong method is 405.
 */
import { commandsModule } from "./commands/index.ts";
import type { Env } from "./env.ts";
import { githubModule } from "./github/index.ts";
import { errorText, handleInteraction } from "./interactions.ts";
import { linkedRolesModule } from "./linked-roles/index.ts";
import { RESERVED_ROUTES, Registry, type BotModule, type ServicesFactory } from "./registry.ts";
import { createServices } from "./services.ts";
import { handleGitHubWebhook } from "./webhooks.ts";

export const modules: readonly BotModule[] = [githubModule, commandsModule, linkedRolesModule];

export interface WorkerOptions {
  modules?: readonly BotModule[];
  services?: ServicesFactory;
}

function methodNotAllowed(allow: string): Response {
  return new Response("method not allowed", { status: 405, headers: { Allow: allow } });
}

export function createWorker(options: WorkerOptions = {}): ExportedHandler<Env> {
  const registry = new Registry(options.modules ?? modules);
  const makeServices = options.services ?? createServices;

  return {
    async fetch(request, env, ctx) {
      const { pathname } = new URL(request.url);
      const method = request.method.toUpperCase();
      const services = makeServices(env, (promise) => ctx.waitUntil(promise));
      try {
        const reserved = RESERVED_ROUTES.find((r) => r.endsWith(` ${pathname}`));
        if (reserved) {
          if (method !== "POST") return methodNotAllowed("POST");
          return pathname === "/interactions"
            ? await handleInteraction(request, env, services, registry)
            : await handleGitHubWebhook(request, env, services, registry);
        }
        const route = registry.route(method, pathname);
        if (route) return await route.handler.handle(request, services);
        if (registry.hasPath(pathname)) return methodNotAllowed("GET");
        return new Response("not found", { status: 404 });
      } catch (error) {
        console.error(`${method} ${pathname} failed:`, errorText(error));
        return new Response("internal error", { status: 500 });
      }
    },

    async scheduled(controller, env, ctx) {
      const services = makeServices(env, (promise) => ctx.waitUntil(promise));
      for (const mod of registry.scheduledModules()) {
        ctx.waitUntil(
          (async () => {
            try {
              await mod.scheduled?.(controller, services);
            } catch (error) {
              console.error(`scheduled ${mod.name} failed:`, errorText(error));
            }
          })(),
        );
      }
    },
  };
}

export default createWorker();
