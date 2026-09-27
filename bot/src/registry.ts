/**
 * Module registration.
 *
 * Every feature module (src/github/, src/commands/, src/linked-roles/) exports
 * one BotModule from its index.ts. src/index.ts imports the three and builds a
 * Registry from them at startup; a conflict (two handlers for one command,
 * custom_id prefix or route) throws there, before any request is served.
 *
 * How each part is dispatched:
 *
 * | Field                  | Trigger                                            | Time budget             |
 * |------------------------|----------------------------------------------------|-------------------------|
 * | commands               | interaction type 2 (by name and command type) and  | 3 s, else return        |
 * |                        | type 4 autocomplete (Command.autocomplete)         | defer() from            |
 * |                        |                                                    | interactions.ts         |
 * | components             | interaction type 3 and 5, custom_id "prefix:rest"  | 3 s, same               |
 * | github                 | POST /github, by X-GitHub-Event and payload.action | runs in waitUntil after |
 * |                        |                                                    | the 202 reply           |
 * | routes                 | only the paths in MODULE_ROUTES                    | normal request          |
 * | scheduled              | the wrangler.toml cron trigger                     | runs in waitUntil       |
 * | roleConnectionMetadata | scripts/register-metadata.ts                       | -                       |
 * | commands[].definition  | scripts/register-commands.ts                       | -                       |
 */
import type { Env } from "./env.ts";
import type { Services } from "./services.ts";
import type {
  ApplicationCommandDefinition,
  Interaction,
  InteractionResponse,
  RoleConnectionMetadata,
} from "./types.ts";

/** Paths src/index.ts serves itself. */
export const RESERVED_ROUTES = ["POST /interactions", "POST /github"] as const;

/** Paths a module may serve. Adding one is a change to src/index.ts's contract. */
export const MODULE_ROUTES = [
  "GET /linked-roles",
  "GET /linked-roles/discord/callback",
  "GET /linked-roles/github/callback",
] as const;

export type ModuleRoute = (typeof MODULE_ROUTES)[number];

export const MAX_ROLE_CONNECTION_METADATA = 5;
export const MAX_MESSAGE_COMMANDS = 5;
export const MAX_USER_COMMANDS = 5;

export interface InteractionContext {
  interaction: Interaction;
  services: Services;
}

export interface AutocompleteChoice {
  name: string;
  value: string | number;
}

export interface Command {
  /** Sent to Discord by scripts/register-commands.ts. `type` defaults to 1 (slash command). */
  definition: ApplicationCommandDefinition;
  /**
   * Answers within 3 s: return a message response, or defer() and finish in
   * the background. Mentions are suppressed in whatever is returned.
   */
  execute(ctx: InteractionContext): Promise<InteractionResponse> | InteractionResponse;
  /** Choices for the focused option; at most 25 are sent. */
  autocomplete?(ctx: InteractionContext): Promise<AutocompleteChoice[]> | AutocompleteChoice[];
}

export interface ComponentHandler {
  /** Owns every custom_id of the form "<prefix>:<anything>" (buttons, selects, modals). */
  prefix: string;
  handle(ctx: InteractionContext): Promise<InteractionResponse> | InteractionResponse;
}

export interface GitHubEventContext {
  event: string;
  action: string | undefined;
  delivery: string | null;
  payload: Record<string, unknown>;
  services: Services;
}

export interface GitHubHandler {
  /** X-GitHub-Event value, e.g. "pull_request". */
  event: string;
  /** payload.action values to receive; omitted means every action. */
  actions?: string[];
  handle(ctx: GitHubEventContext): Promise<void>;
}

export interface HttpRoute {
  route: ModuleRoute;
  handle(request: Request, services: Services): Promise<Response> | Response;
}

export interface BotModule {
  name: string;
  commands?: Command[];
  components?: ComponentHandler[];
  github?: GitHubHandler[];
  routes?: HttpRoute[];
  scheduled?(controller: ScheduledController, services: Services): Promise<void>;
  roleConnectionMetadata?: RoleConnectionMetadata[];
}

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryError";
  }
}

function commandKey(name: string, type: number | undefined): string {
  return `${type ?? 1}:${name}`;
}

export interface Registered<T> {
  module: string;
  handler: T;
}

export class Registry {
  readonly modules: readonly BotModule[];
  readonly #commands = new Map<string, Registered<Command>>();
  readonly #components = new Map<string, Registered<ComponentHandler>>();
  readonly #routes = new Map<string, Registered<HttpRoute>>();
  readonly #github: Array<Registered<GitHubHandler>> = [];
  readonly #metadata: RoleConnectionMetadata[] = [];

  constructor(modules: readonly BotModule[]) {
    this.modules = modules;
    const names = new Set<string>();
    for (const mod of modules) {
      if (names.has(mod.name)) throw new RegistryError(`module ${mod.name} is registered twice`);
      names.add(mod.name);

      for (const command of mod.commands ?? []) {
        const key = commandKey(command.definition.name, command.definition.type);
        const existing = this.#commands.get(key);
        if (existing) {
          throw new RegistryError(`command ${command.definition.name} registered by ${existing.module} and ${mod.name}`);
        }
        this.#commands.set(key, { module: mod.name, handler: command });
      }

      for (const component of mod.components ?? []) {
        if (!/^[a-z0-9-]+$/.test(component.prefix)) {
          throw new RegistryError(`${mod.name}: component prefix ${component.prefix} must match [a-z0-9-]+`);
        }
        const existing = this.#components.get(component.prefix);
        if (existing) {
          throw new RegistryError(`component prefix ${component.prefix} registered by ${existing.module} and ${mod.name}`);
        }
        this.#components.set(component.prefix, { module: mod.name, handler: component });
      }

      for (const route of mod.routes ?? []) {
        if (!(MODULE_ROUTES as readonly string[]).includes(route.route)) {
          throw new RegistryError(`${mod.name}: route ${route.route} is not in MODULE_ROUTES`);
        }
        const existing = this.#routes.get(route.route);
        if (existing) throw new RegistryError(`route ${route.route} registered by ${existing.module} and ${mod.name}`);
        this.#routes.set(route.route, { module: mod.name, handler: route });
      }

      for (const handler of mod.github ?? []) this.#github.push({ module: mod.name, handler });

      for (const record of mod.roleConnectionMetadata ?? []) {
        if (this.#metadata.some((m) => m.key === record.key)) {
          throw new RegistryError(`role connection metadata key ${record.key} registered twice`);
        }
        this.#metadata.push(record);
      }
    }

    const definitions = this.commandDefinitions();
    if (definitions.filter((d) => d.type === 3).length > MAX_MESSAGE_COMMANDS) {
      throw new RegistryError(`more than ${MAX_MESSAGE_COMMANDS} message commands`);
    }
    if (definitions.filter((d) => d.type === 2).length > MAX_USER_COMMANDS) {
      throw new RegistryError(`more than ${MAX_USER_COMMANDS} user commands`);
    }
    if (this.#metadata.length > MAX_ROLE_CONNECTION_METADATA) {
      throw new RegistryError(`more than ${MAX_ROLE_CONNECTION_METADATA} role connection metadata records`);
    }
  }

  command(name: string, type: number | undefined): Registered<Command> | undefined {
    return this.#commands.get(commandKey(name, type));
  }

  /** Handler for a custom_id "prefix:rest"; a custom_id without a colon matches its whole value. */
  component(customId: string): Registered<ComponentHandler> | undefined {
    return this.#components.get(customId.split(":", 1)[0] ?? "");
  }

  route(method: string, path: string): Registered<HttpRoute> | undefined {
    return this.#routes.get(`${method.toUpperCase()} ${path}`);
  }

  /** True when some module serves `path` under any method. */
  hasPath(path: string): boolean {
    for (const key of this.#routes.keys()) if (key.slice(key.indexOf(" ") + 1) === path) return true;
    return false;
  }

  githubHandlers(event: string, action: string | undefined): Array<Registered<GitHubHandler>> {
    return this.#github.filter(
      ({ handler }) =>
        handler.event === event && (!handler.actions || (action !== undefined && handler.actions.includes(action))),
    );
  }

  commandDefinitions(): ApplicationCommandDefinition[] {
    return [...this.#commands.values()].map(({ handler }) => handler.definition);
  }

  roleConnectionMetadata(): RoleConnectionMetadata[] {
    return [...this.#metadata];
  }

  scheduledModules(): BotModule[] {
    return this.modules.filter((m) => m.scheduled);
  }
}

/** Services factory signature, replaceable in tests. */
export type ServicesFactory = (env: Env, waitUntil: (promise: Promise<unknown>) => void) => Services;
