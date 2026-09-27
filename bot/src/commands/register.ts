/**
 * Checks for the command list scripts/register-commands.ts sends to Discord
 * (guild-scoped bulk overwrite). Kept out of the script so tests can run it.
 */
import type { ApplicationCommandDefinition } from "../types.ts";

const SLASH_NAME = /^[-_\p{Ll}\p{Lo}\p{N}]{1,32}$/u;

/** Problems that would make Discord reject the list or register an unrestricted command; empty when fine. */
export function definitionProblems(definitions: ApplicationCommandDefinition[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const d of definitions) {
    const type = d.type ?? 1;
    const key = `${type}:${d.name}`;
    if (seen.has(key)) problems.push(`${d.name}: registered twice`);
    seen.add(key);
    if (type === 1) {
      if (!SLASH_NAME.test(d.name)) problems.push(`${d.name}: slash command names are 1-32 lowercase characters`);
      if (!d.description || d.description.length > 100) problems.push(`${d.name}: description must be 1-100 characters`);
    } else {
      if (d.name.length < 1 || d.name.length > 32) problems.push(`${d.name}: name must be 1-32 characters`);
      if (d.description) problems.push(`${d.name}: context-menu commands take no description`);
    }
    if (typeof d.default_member_permissions !== "string" || !/^\d+$/.test(d.default_member_permissions)) {
      problems.push(`${d.name}: default_member_permissions must be set`);
    }
    if (JSON.stringify(d.contexts) !== "[0]") problems.push(`${d.name}: contexts must be [0] (guild only)`);
  }
  return problems;
}

/** --dry-run prints only the JSON body; it cannot be combined with --yes. */
export function splitDryRun(argv: string[]): { dryRun: boolean; rest: string[] } {
  return { dryRun: argv.includes("--dry-run"), rest: argv.filter((a) => a !== "--dry-run") };
}
