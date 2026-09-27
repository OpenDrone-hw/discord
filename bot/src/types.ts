/**
 * The subset of Discord API shapes the bot uses. Field names match the API.
 * Unknown fields are allowed through the index signatures so handlers can
 * read newer data without a type change here.
 */

export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
} as const;

export const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  APPLICATION_COMMAND_AUTOCOMPLETE_RESULT: 8,
  MODAL: 9,
} as const;

export const ApplicationCommandType = {
  CHAT_INPUT: 1,
  USER: 2,
  MESSAGE: 3,
} as const;

export const ChannelType = {
  GUILD_TEXT: 0,
  GUILD_VOICE: 2,
  GUILD_CATEGORY: 4,
  GUILD_ANNOUNCEMENT: 5,
  PUBLIC_THREAD: 11,
  GUILD_STAGE_VOICE: 13,
  GUILD_FORUM: 15,
  GUILD_MEDIA: 16,
} as const;

export const MessageFlags = {
  EPHEMERAL: 1 << 6,
  SUPPRESS_EMBEDS: 1 << 2,
  IS_COMPONENTS_V2: 1 << 15,
} as const;

export interface AllowedMentions {
  parse?: Array<"roles" | "users" | "everyone">;
  roles?: string[];
  users?: string[];
  replied_user?: boolean;
}

export interface MessagePayload {
  content?: string;
  embeds?: unknown[];
  components?: unknown[];
  flags?: number;
  allowed_mentions?: AllowedMentions;
  [key: string]: unknown;
}

export interface User {
  id: string;
  username: string;
  global_name?: string | null;
  [key: string]: unknown;
}

export interface GuildMember {
  user?: User;
  roles: string[];
  permissions?: string;
  [key: string]: unknown;
}

export interface Interaction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  guild_id?: string;
  channel_id?: string;
  member?: GuildMember;
  user?: User;
  data?: InteractionData;
  message?: { id: string; channel_id: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface InteractionData {
  id?: string;
  name?: string;
  type?: number;
  custom_id?: string;
  target_id?: string;
  options?: Array<{ name: string; type: number; value?: unknown; focused?: boolean; options?: unknown[] }>;
  resolved?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface InteractionResponse {
  type: number;
  data?: MessagePayload | { choices: Array<{ name: string; value: string | number }> } | Record<string, unknown>;
}

export interface ApplicationCommandDefinition {
  name: string;
  type?: number;
  description?: string;
  options?: unknown[];
  default_member_permissions?: string | null;
  contexts?: number[];
  [key: string]: unknown;
}

export interface Channel {
  id: string;
  type: number;
  name?: string;
  parent_id?: string | null;
  position?: number;
  available_tags?: Array<{ id: string; name: string; moderated?: boolean }>;
  [key: string]: unknown;
}

export interface Role {
  id: string;
  name: string;
  managed?: boolean;
  position?: number;
  [key: string]: unknown;
}

/** Application role connection metadata record (Linked Roles). */
export interface RoleConnectionMetadata {
  type: number;
  key: string;
  name: string;
  description: string;
  [key: string]: unknown;
}
