/**
 * Interaction commands module.
 *
 * | Command                  | Type         | Who (checked in code)         | Reply                                  |
 * |--------------------------|--------------|-------------------------------|----------------------------------------|
 * | /link pr:<url>           | slash        | members; private repos: staff | ephemeral, plus a note in the thread   |
 * | /branch [repo]           | slash        | anyone who can use it         | ephemeral                              |
 * | /editing repo:<name>     | slash        | anyone; private repos: staff  | ephemeral                              |
 * | /verify                  | slash        | anyone who can use it         | ephemeral                              |
 * | /promote name summary    | slash        | admin, PROMOTE_ENABLED="true" | ephemeral                              |
 * | To GitHub issue          | message menu | members; private repos: staff | modal, then ephemeral and a reply      |
 * | Approve build            | message menu | reviewer or admin             | ephemeral                              |
 *
 * Every command is guild-only (contexts [0]). Anything that calls an API
 * defers and finishes in ctx.waitUntil; see src/interactions.ts defer().
 */
import type { BotModule } from "../registry.ts";
import { approveBuildCommand } from "./approve-build.ts";
import { branchCommand } from "./branch.ts";
import { editingCommand } from "./editing.ts";
import { linkCommand } from "./link.ts";
import { promoteCommand } from "./promote.ts";
import { toIssueCommand, toIssueModal } from "./to-issue.ts";
import { verifyCommand } from "./verify.ts";

export const commandsModule: BotModule = {
  name: "commands",
  commands: [linkCommand, branchCommand, editingCommand, verifyCommand, promoteCommand, toIssueCommand, approveBuildCommand],
  components: [toIssueModal],
};
