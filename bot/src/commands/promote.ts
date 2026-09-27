/**
 * /promote name:<repo> summary:<text> [private]: admin only. Creates a
 * repository in the organisation from <org>/hardware-template and sets the
 * lifecycle topic status-planned.
 *
 * Disabled unless the PROMOTE_ENABLED var is exactly "true". Creating a
 * repository from a template and setting topics need the GitHub App's
 * "Administration: Read and write" repository permission, which the App does
 * not hold by default (see bot/README.md, GitHub App).
 */
import { promoteEnabled } from "../env.ts";
import { GitHubError } from "../github.ts";
import { defer, ephemeral } from "../interactions.ts";
import type { Command, InteractionContext } from "../registry.ts";
import { ApplicationCommandType, type Interaction } from "../types.ts";
import { ADMIN_PERMISSIONS, code, guildOnly, hasRole, repoRequest, resolveRepoName, stringOption, truncate } from "./util.ts";

export const TEMPLATE_REPO = "hardware-template";
export const INITIAL_TOPIC = "status-planned";
export const SUMMARY_MAX = 350;
export const DISABLED = "/promote is disabled. It needs PROMOTE_ENABLED set to \"true\" in wrangler.toml.";
export const NOT_ADMIN = "Only admins can create repositories.";

/** Delays between topic attempts while GitHub finishes generating the repository. Replaceable in tests. */
export const timing = { topicRetryMs: [1_000, 2_000] };

/** Null when `name` is a valid new GitHub repository name, else the reason it is not. */
export function repoNameProblem(name: string): string | null {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) return "use 1 to 100 letters, digits, '.', '-' or '_'";
  if (name === "." || name === "..") return "it cannot be '.' or '..'";
  if (/\.git$/i.test(name)) return "it cannot end in .git";
  return null;
}

function booleanOption(interaction: Interaction, name: string): boolean {
  return interaction.data?.options?.find((o) => o.name === name)?.value === true;
}

interface Repository {
  full_name: string;
  html_url: string;
}

async function setTopic(ctx: InteractionContext, name: string): Promise<boolean> {
  const org = ctx.services.directory.config.org;
  const delays = [0, ...timing.topicRetryMs];
  for (const delay of delays) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await repoRequest(ctx, TEMPLATE_REPO, "PUT", `/repos/${org}/${name}/topics`, { body: { names: [INITIAL_TOPIC] } });
      return true;
    } catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 404) throw error;
    }
  }
  return false;
}

async function promote(ctx: InteractionContext, name: string, summary: string, isPrivate: boolean): Promise<string> {
  if (!(await hasRole(ctx, ["admin"]))) return NOT_ADMIN;
  const org = ctx.services.directory.config.org;
  let repo: Repository;
  try {
    repo = await repoRequest<Repository>(ctx, TEMPLATE_REPO, "POST", `/repos/${org}/${TEMPLATE_REPO}/generate`, {
      body: { owner: org, name, description: summary, private: isPrivate, include_all_branches: false },
    });
  } catch (error) {
    if (error instanceof GitHubError && error.status === 422) {
      return `GitHub refused to create ${org}/${name} (it may already exist): ${truncate(error.message, 300)}`;
    }
    if (error instanceof GitHubError && (error.status === 403 || error.status === 404)) {
      return `GitHub refused to create ${org}/${name}. The GitHub App needs "Administration: Read and write" on ${org}.`;
    }
    throw error;
  }
  const topic = (await setTopic(ctx, name))
    ? `with topic ${INITIAL_TOPIC}`
    : `but setting topic ${INITIAL_TOPIC} failed; add it on GitHub`;
  return [
    `Created ${isPrivate ? "private" : "public"} repository ${repo.full_name} from ${TEMPLATE_REPO} ${topic}: <${repo.html_url}>`,
    `Add ${name} to bot/config/repos.json with its forum and product tag so the bot maps it to a forum.`,
  ].join("\n");
}

export const promoteCommand: Command = {
  definition: {
    name: "promote",
    type: ApplicationCommandType.CHAT_INPUT,
    description: "Create a hardware repository from hardware-template (admin)",
    options: [
      { type: 3, name: "name", description: "Repository name, e.g. OpenPDB", required: true, min_length: 1, max_length: 100 },
      { type: 3, name: "summary", description: "One-line description", required: true, min_length: 1, max_length: SUMMARY_MAX },
      { type: 5, name: "private", description: "Create it private (default public)", required: false },
    ],
    default_member_permissions: ADMIN_PERMISSIONS,
    ...guildOnly(),
  },
  execute(ctx) {
    if (!promoteEnabled(ctx.services.env)) return ephemeral(DISABLED);
    const name = stringOption(ctx.interaction, "name") ?? "";
    const summary = (stringOption(ctx.interaction, "summary") ?? "").replace(/\s+/g, " ");
    const problem = repoNameProblem(name);
    if (problem) return ephemeral(`${code(truncate(name, 100))} is not a repository name: ${problem}.`);
    if (resolveRepoName(ctx, name)) return ephemeral(`${name} is already in bot/config/repos.json.`);
    if (!summary || summary.length > SUMMARY_MAX) return ephemeral(`Give a summary of 1 to ${SUMMARY_MAX} characters.`);
    return defer(ctx, () => promote(ctx, name, summary, booleanOption(ctx.interaction, "private")), { ephemeral: true });
  },
};
