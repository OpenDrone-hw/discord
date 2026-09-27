/**
 * GitHub facts behind the metadata, read with the GitHub App installation on
 * the organisation (Organization permission "Members: Read"), so they do not
 * depend on what the user's own token can see.
 *
 * | Fact        | Call                                                        | Result          |
 * |-------------|-------------------------------------------------------------|-----------------|
 * | merged PRs  | GET /search/issues?q=is:pr is:merged org:<org> author:<login> | total_count     |
 * | org member  | GET /orgs/<org>/members/<login>                             | 204 yes, 404 no |
 * | maintainer  | GET /orgs/<org>/teams/<team>/memberships/<login>            | state "active"  |
 */
import { GitHubError, type GitHubApp } from "../github.ts";
import { GITHUB_LOGIN } from "./oauth.ts";

export const DEFAULT_MAINTAINER_TEAM = "maintainers";
const TEAM_SLUG = /^[A-Za-z0-9._-]{1,100}$/;

export interface GitHubFacts {
  mergedPrs: number;
  orgMember: boolean;
  maintainer: boolean;
}

const installations = new Map<string, Promise<string>>();

/** Drops cached installation ids (tests, or after an installation was replaced). */
export function clearInstallationCache(): void {
  installations.clear();
}

function isNotFound(error: unknown): boolean {
  return error instanceof GitHubError && error.status === 404;
}

export function mergedPrQuery(org: string, login: string): string {
  return `is:pr is:merged org:${org} author:${login}`;
}

export class OrgStats {
  readonly #app: GitHubApp;
  readonly #org: string;
  readonly #team: string;

  constructor(app: GitHubApp, org: string, team: string = DEFAULT_MAINTAINER_TEAM) {
    if (!TEAM_SLUG.test(team)) throw new Error(`maintainer team ${JSON.stringify(team)} is not a team slug`);
    this.#app = app;
    this.#org = org;
    this.#team = team;
  }

  installationId(): Promise<string> {
    const key = `${this.#app.appId}/${this.#org.toLowerCase()}`;
    let id = installations.get(key);
    if (!id) {
      id = this.#app
        .appRequest<{ id: number }>("GET", `/orgs/${encodeURIComponent(this.#org)}/installation`)
        .then((r) => String(r.id));
      installations.set(key, id);
      id.catch(() => {
        if (installations.get(key) === id) installations.delete(key);
      });
    }
    return id;
  }

  async facts(login: string): Promise<GitHubFacts> {
    if (!GITHUB_LOGIN.test(login)) throw new Error(`${JSON.stringify(login)} is not a GitHub login`);
    const installation = await this.installationId();
    const org = encodeURIComponent(this.#org);
    const user = encodeURIComponent(login);

    const merged = this.#app
      .request<{ total_count?: unknown }>(installation, "GET", "/search/issues", {
        query: { q: mergedPrQuery(this.#org, login), per_page: 1 },
      })
      .then((r) => (typeof r?.total_count === "number" && r.total_count >= 0 ? Math.floor(r.total_count) : 0));

    const member = this.#app
      .request(installation, "GET", `/orgs/${org}/members/${user}`)
      .then(() => true)
      .catch((error: unknown) => {
        if (isNotFound(error)) return false;
        throw error;
      });

    const maintainer = this.#app
      .request<{ state?: unknown }>(installation, "GET", `/orgs/${org}/teams/${encodeURIComponent(this.#team)}/memberships/${user}`)
      .then((r) => r?.state === "active")
      .catch((error: unknown) => {
        if (isNotFound(error)) return false;
        throw error;
      });

    const [mergedPrs, orgMember, isMaintainer] = await Promise.all([merged, member, maintainer]);
    return { mergedPrs, orgMember, maintainer: isMaintainer };
  }
}
