/**
 * Registers the linked-role connection metadata records of every module.
 *
 *   npm run register-metadata            # print what would be sent
 *   npm run register-metadata -- --yes   # send it
 *
 * APPLICATION_ID comes from the environment or wrangler.toml. The PUT
 * replaces all records, so an empty list is refused.
 */
import { DiscordClient } from "../src/discord.ts";
import { modules } from "../src/index.ts";
import { Registry } from "../src/registry.ts";
import { botToken, main, parseArgs, setting, UsageError } from "./lib.ts";

const USAGE = "usage: npm run register-metadata [-- --yes]\n";

await main(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  const records = new Registry(modules).roleConnectionMetadata();
  const applicationId = setting("APPLICATION_ID");
  process.stdout.write(
    `PUT /applications/${applicationId}/role-connections/metadata\n${JSON.stringify(records, null, 2)}\n`,
  );
  if (records.length === 0) {
    if (args.yes) throw new UsageError("no module registers metadata; refusing to clear the application's records");
    process.stdout.write("No module registers role connection metadata.\n");
    return;
  }
  if (!args.yes) {
    process.stdout.write("Dry run. Re-run with --yes to send.\n");
    return;
  }
  const client = new DiscordClient({ token: botToken() });
  const result = await client.putRoleConnectionMetadata(applicationId, records);
  process.stdout.write(`Registered ${result.length} metadata records.\n`);
});
