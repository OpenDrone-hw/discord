/**
 * Per-request service bundle handed to every handler. Clients are created on
 * first use and reused across requests in the same isolate, so rate-limit
 * buckets, the App JWT and installation tokens survive between requests.
 */
import { Directory } from "./config.ts";
import { DiscordClient } from "./discord.ts";
import type { Env } from "./env.ts";
import { GitHubApp } from "./github.ts";

export interface Services {
  env: Env;
  /** Keeps the Worker alive for background work after the response is sent. */
  waitUntil(promise: Promise<unknown>): void;
  readonly discord: DiscordClient;
  readonly github: GitHubApp;
  readonly directory: Directory;
}

let discordClient: { token: string; client: DiscordClient } | undefined;
let githubApp: { appId: string; key: string; app: GitHubApp } | undefined;

function sharedDiscord(env: Env): DiscordClient {
  if (!discordClient || discordClient.token !== env.DISCORD_BOT_TOKEN) {
    discordClient = { token: env.DISCORD_BOT_TOKEN, client: new DiscordClient({ token: env.DISCORD_BOT_TOKEN }) };
  }
  return discordClient.client;
}

function sharedGitHub(env: Env): GitHubApp {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) {
    throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be set");
  }
  if (!githubApp || githubApp.appId !== env.GITHUB_APP_ID || githubApp.key !== env.GITHUB_APP_PRIVATE_KEY) {
    githubApp = {
      appId: env.GITHUB_APP_ID,
      key: env.GITHUB_APP_PRIVATE_KEY,
      app: new GitHubApp({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY }),
    };
  }
  return githubApp.app;
}

export function createServices(env: Env, waitUntil: (promise: Promise<unknown>) => void): Services {
  let directory: Directory | undefined;
  return {
    env,
    waitUntil,
    get discord() {
      return sharedDiscord(env);
    },
    get github() {
      return sharedGitHub(env);
    },
    get directory() {
      directory ??= new Directory(sharedDiscord(env), env.GUILD_ID);
      return directory;
    },
  };
}
