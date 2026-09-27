/**
 * Interaction commands module: slash commands, message context-menu commands,
 * their autocomplete, and the components and modals they open.
 *
 * Stub: registers nothing. A command is added as
 *
 *   commands: [{
 *     definition: { name: "link", description: "...", options: [...] },
 *     execute: (ctx) => ephemeral("..."),            // or defer(ctx, async () => ...)
 *     autocomplete: (ctx) => [{ name: "OpenRX", value: "OpenRX" }],
 *   }],
 *   components: [{ prefix: "verify", handle: (ctx) => ... }],   // custom_id "verify:..."
 *
 * Contract: src/registry.ts (Command, ComponentHandler). Helpers:
 * src/interactions.ts (messageResponse, ephemeral, defer).
 */
import type { BotModule } from "../registry.ts";

export const commandsModule: BotModule = {
  name: "commands",
  commands: [],
  components: [],
};
