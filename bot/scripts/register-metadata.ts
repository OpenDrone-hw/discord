/**
 * Registers the linked-role connection metadata records of every module.
 *
 *   npm run register-metadata                 # print what would be sent
 *   npm run register-metadata -- --dry-run    # the same, explicitly
 *   npm run register-metadata -- --yes        # send it
 *
 * --dry-run wins over --yes. APPLICATION_ID comes from the environment or
 * wrangler.toml. The PUT replaces all records, so an empty list is refused,
 * and a schema Discord would reject is refused before anything is sent.
 * The token is read only when sending and never printed.
 */
import { DiscordClient } from "../src/discord.ts";
import { modules } from "../src/index.ts";
import { metadataProblems } from "../src/linked-roles/metadata.ts";
import { Registry } from "../src/registry.ts";
import { botToken, main, parseArgs, setting, UsageError } from "./lib.ts";

export const USAGE = "usage: npm run register-metadata [-- --dry-run | --yes]\n";

export interface RunDeps {
  write(text: string): void;
  applicationId(): string;
  client(): DiscordClient;
}

const defaultDeps: RunDeps = {
  write: (text) => void process.stdout.write(text),
  applicationId: () => setting("APPLICATION_ID"),
  client: () => new DiscordClient({ token: botToken() }),
};

export async function run(argv: string[], deps: RunDeps = defaultDeps): Promise<void> {
  const dryRun = argv.includes("--dry-run");
  const args = parseArgs(argv.filter((a) => a !== "--dry-run"));
  if (args.help) {
    deps.write(USAGE);
    return;
  }
  const records = new Registry(modules).roleConnectionMetadata();
  const applicationId = deps.applicationId();
  deps.write(`PUT /applications/${applicationId}/role-connections/metadata\n${JSON.stringify(records, null, 2)}\n`);
  const problems = metadataProblems(records);
  if (problems.length > 0) throw new UsageError(`invalid metadata:\n  ${problems.join("\n  ")}`);
  if (records.length === 0) {
    if (args.yes && !dryRun) throw new UsageError("no module registers metadata; refusing to clear the application's records");
    deps.write("No module registers role connection metadata.\n");
    return;
  }
  if (dryRun || !args.yes) {
    deps.write("Dry run. Re-run with --yes to send.\n");
    return;
  }
  const result = await deps.client().putRoleConnectionMetadata(applicationId, records);
  deps.write(`Registered ${result.length} metadata records.\n`);
}

// Run only as a script (npm run register-metadata), not when a test imports it.
if (process.argv[1]?.endsWith("register-metadata.ts")) await main(() => run(process.argv.slice(2)));
