/**
 * Per-delivery scope shared by the handlers: the repository, its GitHub API,
 * the redelivery guard and helpers that post to named channels and threads.
 */
import { LIFECYCLE_TOPICS, type ChannelKey, type LifecycleTopic } from "../config.ts";
import { DiscordError } from "../discord.ts";
import { errorText } from "../interactions.ts";
import type { GitHubEventContext } from "../registry.ts";
import type { Services } from "../services.ts";
import type { MessagePayload } from "../types.ts";
import { RepoApi } from "./api.ts";
import { onceFor, storeFor, type Once } from "./deliveries.ts";
import { installationId, readRepo, senderLogin, type Repo } from "./payload.ts";

export interface Scope {
  services: Services;
  repo: Repo;
  api: RepoApi;
  once: Once;
  sender: string;
  guildId: string;
  action: string | undefined;
  payload: Record<string, unknown>;
}

/**
 * Scope for a delivery, or null when it has no repository or the repository
 * is outside the configured organisation.
 */
export function makeScope(ctx: GitHubEventContext): Scope | null {
  const repo = readRepo(ctx.payload.repository);
  if (!repo) return null;
  if (repo.owner.toLowerCase() !== ctx.services.directory.config.org.toLowerCase()) return null;
  return {
    services: ctx.services,
    repo,
    api: new RepoApi(() => ctx.services.github, repo, installationId(ctx.payload)),
    once: onceFor(storeFor(ctx.services.env.DB), ctx.delivery),
    sender: senderLogin(ctx.payload),
    guildId: ctx.services.env.GUILD_ID,
    action: ctx.action,
    payload: ctx.payload,
  };
}

/** Most advanced status-* topic of a repository, or null. */
export function currentStatus(topics: readonly string[]): LifecycleTopic | null {
  let status: LifecycleTopic | null = null;
  for (const topic of LIFECYCLE_TOPICS) if (topics.includes(topic)) status = topic;
  return status;
}

/** Posts to a channel named in config/repos.json; a missing channel is logged and skipped. */
export async function postToChannel(services: Services, key: ChannelKey, message: MessagePayload): Promise<boolean> {
  const channelId = await services.directory.channelId(key);
  if (!channelId) {
    console.warn(`channel ${services.directory.config.channels[key]} (${key}) does not exist; message dropped`);
    return false;
  }
  await services.discord.sendMessage(channelId, message);
  return true;
}

/**
 * Posts to the product text channel config/repos.json maps the scope's
 * repository to. A repository that is not listed posts nothing; a listed one
 * whose channel is missing throws ConfigError (Directory.resolveRepo).
 */
export async function postToProductChannel(scope: Scope, message: MessagePayload): Promise<boolean> {
  const resolved = await scope.services.directory.resolveRepo(scope.repo.fullName);
  if (!resolved) {
    console.warn(`${scope.repo.fullName} is not in config/repos.json; product channel message dropped`);
    return false;
  }
  await scope.services.discord.sendMessage(resolved.channelId, message);
  return true;
}

/**
 * Posts into a linked thread. A thread that was deleted or that the bot
 * cannot reach is logged and skipped; the PR keeps its link.
 */
export async function postToThread(services: Services, threadId: string, message: MessagePayload): Promise<boolean> {
  try {
    await services.discord.sendMessage(threadId, message);
    return true;
  } catch (error) {
    if (error instanceof DiscordError && (error.status === 404 || error.status === 403)) {
      console.warn(`linked thread ${threadId} is unavailable: ${error.message}`);
      return false;
    }
    throw error;
  }
}

/** Runs every task, then throws one error naming all failures so the webhook log shows each. */
export async function runAll(label: string, tasks: Array<() => Promise<unknown>>): Promise<void> {
  const errors: unknown[] = [];
  for (const task of tasks) {
    try {
      await task();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, `${label}: ${errors.length} steps failed: ${errors.map(errorText).join("; ")}`);
}
