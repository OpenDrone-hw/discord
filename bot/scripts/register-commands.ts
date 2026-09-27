/**
 * Registers every module's commands as guild commands (bulk overwrite).
 *
 *   npm run register-commands            # print what would be sent
 *   npm run register-commands -- --yes   # send it
 *
 * APPLICATION_ID and GUILD_ID come from the environment or wrangler.toml.
 * The PUT replaces the guild's whole command list, so an empty list is refused.
 */
import { DiscordClient } from "../src/discord.ts";
import { modules } from "../src/index.ts";
import { Registry } from "../src/registry.ts";
import { botToken, main, parseArgs, setting, UsageError } from "./lib.ts";

const USAGE = "usage: npm run register-commands [-- --yes]\n";

await main(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  const definitions = new Registry(modules).commandDefinitions();
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
