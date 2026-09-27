/**
 * POST /interactions: signature check, PING, and dispatch to the registry.
 * Response helpers for command and component handlers live here too.
 */
import { noMentions } from "./discord.ts";
import type { Env } from "./env.ts";
import type { InteractionContext, Registry } from "./registry.ts";
import type { Services } from "./services.ts";
import {
  InteractionResponseType,
  InteractionType,
  MessageFlags,
  type Interaction,
  type InteractionResponse,
  type MessagePayload,
} from "./types.ts";
import { verifyDiscordSignature } from "./verify.ts";

export const WRONG_GUILD_TEXT = "This bot only works in the OpenDrone server.";
export const UNKNOWN_TEXT = "This command is not available.";
export const ERROR_TEXT = "Something went wrong. The error was logged.";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A message reply. Mentions are suppressed unless allowed_mentions is set. */
export function messageResponse(
  message: MessagePayload | string,
  options: { ephemeral?: boolean } = {},
): InteractionResponse {
  const data: MessagePayload = typeof message === "string" ? { content: message } : { ...message };
  if (options.ephemeral) data.flags = (data.flags ?? 0) | MessageFlags.EPHEMERAL;
  data.allowed_mentions ??= noMentions();
  return { type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data };
}

export function ephemeral(text: string): InteractionResponse {
  return messageResponse(text, { ephemeral: true });
}

/**
 * Acknowledges now (type 5, "thinking...") and replaces the placeholder with
 * the result of `work` once it finishes, within Discord's 15 minute window.
 * A failure replaces it with ERROR_TEXT.
 */
export function defer(
  ctx: InteractionContext,
  work: () => Promise<MessagePayload | string>,
  options: { ephemeral?: boolean } = {},
): InteractionResponse {
  const { interaction, services } = ctx;
  const finish = async () => {
    let message: MessagePayload;
    try {
      const result = await work();
      message = typeof result === "string" ? { content: result } : result;
    } catch (error) {
      console.error(`deferred interaction ${interaction.data?.name ?? interaction.data?.custom_id ?? "?"} failed:`, errorText(error));
      message = { content: ERROR_TEXT };
    }
    await services.discord.editOriginalResponse(interaction.application_id, interaction.token, message);
  };
  services.waitUntil(
    finish().catch((error) => console.error("could not edit deferred response:", errorText(error))),
  );
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: options.ephemeral ? { flags: MessageFlags.EPHEMERAL } : {},
  };
}

export function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Adds allowed_mentions {parse: []} to message responses that lack it. */
export function finalizeResponse(response: InteractionResponse): InteractionResponse {
  const isMessage =
    response.type === InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE ||
    response.type === InteractionResponseType.UPDATE_MESSAGE;
  if (!isMessage || !response.data || "choices" in response.data) return response;
  const data = response.data as MessagePayload;
  return data.allowed_mentions === undefined ? { ...response, data: { ...data, allowed_mentions: noMentions() } } : response;
}

async function dispatch(interaction: Interaction, services: Services, registry: Registry): Promise<InteractionResponse> {
  const ctx: InteractionContext = { interaction, services };
  const data = interaction.data ?? {};

  switch (interaction.type) {
    case InteractionType.APPLICATION_COMMAND: {
      const found = registry.command(data.name ?? "", data.type);
      if (!found) return ephemeral(UNKNOWN_TEXT);
      try {
        return await found.handler.execute(ctx);
      } catch (error) {
        console.error(`command ${data.name} (${found.module}) failed:`, errorText(error));
        return ephemeral(ERROR_TEXT);
      }
    }
    case InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE: {
      const found = registry.command(data.name ?? "", data.type);
      let choices: Array<{ name: string; value: string | number }> = [];
      if (found?.handler.autocomplete) {
        try {
          choices = (await found.handler.autocomplete(ctx)).slice(0, 25);
        } catch (error) {
          console.error(`autocomplete ${data.name} (${found.module}) failed:`, errorText(error));
        }
      }
      return { type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT, data: { choices } };
    }
    case InteractionType.MESSAGE_COMPONENT:
    case InteractionType.MODAL_SUBMIT: {
      const found = registry.component(data.custom_id ?? "");
      if (!found) return ephemeral(UNKNOWN_TEXT);
      try {
        return await found.handler.handle(ctx);
      } catch (error) {
        console.error(`component ${found.handler.prefix} (${found.module}) failed:`, errorText(error));
        return ephemeral(ERROR_TEXT);
      }
    }
    default:
      return ephemeral(UNKNOWN_TEXT);
  }
}

export async function handleInteraction(
  request: Request,
  env: Env,
  services: Services,
  registry: Registry,
): Promise<Response> {
  const body = await request.text();
  const valid = await verifyDiscordSignature({
    publicKeyHex: env.DISCORD_PUBLIC_KEY ?? "",
    signatureHex: request.headers.get("X-Signature-Ed25519"),
    timestamp: request.headers.get("X-Signature-Timestamp"),
    body,
  });
  if (!valid) return new Response("invalid request signature", { status: 401 });

  let interaction: Interaction;
  try {
    interaction = JSON.parse(body) as Interaction;
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }

  if (interaction.type === InteractionType.PING) return json({ type: InteractionResponseType.PONG });

  if (env.GUILD_ID && interaction.guild_id !== env.GUILD_ID) {
    if (interaction.type === InteractionType.APPLICATION_COMMAND_AUTOCOMPLETE) {
      return json({ type: InteractionResponseType.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT, data: { choices: [] } });
    }
    return json(ephemeral(WRONG_GUILD_TEXT));
  }

  return json(finalizeResponse(await dispatch(interaction, services, registry)));
}
