/**
 * Registers every module's commands as guild commands (bulk overwrite of
 * PUT /applications/{APPLICATION_ID}/guilds/{GUILD_ID}/commands).
 *
 *   npm run register-commands                # print what would be sent
 *   npm run register-commands -- --dry-run   # print only the JSON body
 *   npm run register-commands -- --yes       # send it
 *
 * APPLICATION_ID and GUILD_ID come from the environment or wrangler.toml.
 * The PUT replaces the guild's whole command list, so an empty list is
 * refused, and so is a list with a command lacking default_member_permissions
 * or the guild-only context.
 */
import { definitionProblems, splitDryRun } from "../src/commands/register.ts";
import { DiscordClient } from "../src/discord.ts";
import { modules } from "../src/index.ts";
import { Registry } from "../src/registry.ts";
import { botToken, main, parseArgs, setting, UsageError } from "./lib.ts";

const USAGE = "usage: npm run register-commands [-- --dry-run | --yes]\n";

await main(async () => {
  const { dryRun, rest } = splitDryRun(process.argv.slice(2));
  const args = parseArgs(rest);
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (dryRun && args.yes) throw new UsageError("--dry-run and --yes cannot be combined");
  const definitions = new Registry(modules).commandDefinitions();
  const problems = definitionProblems(definitions);
  if (problems.length > 0) throw new UsageError(`invalid command list:\n${problems.join("\n")}`);
  if (dryRun) {
    process.stdout.write(`${JSON.stringify(definitions, null, 2)}\n`);
    return;
  }
  const applicationId = setting("APPLICATION_ID");
  const guildId = setting("GUILD_ID");
  process.stdout.write(
    `PUT /applications/${applicationId}/guilds/${guildId}/commands\n${JSON.stringify(definitions, null, 2)}\n`,
  );
  if (definitions.length === 0) {
    if (args.yes) throw new UsageError("no module registers a command; refusing to clear the guild's commands");
    process.stdout.write("No module registers a command.\n");
    return;
  }
  if (!args.yes) {
    process.stdout.write("Dry run. Re-run with --yes to send.\n");
    return;
  }
  const client = new DiscordClient({ token: botToken() });
  const result = await client.bulkOverwriteGuildCommands(applicationId, guildId, definitions);
  process.stdout.write(`Registered ${result.length} commands.\n`);
});
