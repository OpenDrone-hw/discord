/**
 * Shared helpers for the register scripts. Every script is a dry run unless
 * called with --yes, refuses unknown arguments, and never prints a token.
 */
import { existsSync, readFileSync } from "node:fs";

export class UsageError extends Error {}

export interface Args {
  yes: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { yes: false, help: false };
  for (const arg of argv) {
    if (arg === "--yes") args.yes = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new UsageError(`unknown argument ${arg}`);
  }
  return args;
}

/** Reads NAME = "value" from the [vars] table of wrangler.toml. */
export function wranglerVar(name: string, toml: string): string | undefined {
  const vars = /^\[vars\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(toml)?.[1] ?? "";
  const match = new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "m").exec(vars);
  return match?.[1];
}

/** KEY=value lines, as in ~/.config/incutec/credentials.env. */
export function envFileValue(name: string, text: string): string | undefined {
  for (const line of text.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match?.[1] === name) return (match[2] ?? "").trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return undefined;
}

const WRANGLER_TOML = new URL("../wrangler.toml", import.meta.url);

/** Environment first, then wrangler.toml [vars]. */
export function setting(name: string): string {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  const fromToml = wranglerVar(name, readFileSync(WRANGLER_TOML, "utf8"));
  if (fromToml) return fromToml;
  throw new UsageError(`${name} is not set in the environment or wrangler.toml`);
}

/**
 * Bot token from DISCORD_BOT_TOKEN, else OPENDRONE_DISCORD_BOT_TOKEN from the
 * environment or ~/.config/incutec/credentials.env. The value is never printed.
 */
export function botToken(): string {
  const direct = process.env.DISCORD_BOT_TOKEN || process.env.OPENDRONE_DISCORD_BOT_TOKEN;
  if (direct) return direct;
  const home = process.env.HOME;
  const file = home ? `${home}/.config/incutec/credentials.env` : undefined;
  if (file && existsSync(file)) {
    const value = envFileValue("OPENDRONE_DISCORD_BOT_TOKEN", readFileSync(file, "utf8"));
    if (value) return value;
  }
  throw new UsageError("set DISCORD_BOT_TOKEN or OPENDRONE_DISCORD_BOT_TOKEN");
}

export async function main(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
