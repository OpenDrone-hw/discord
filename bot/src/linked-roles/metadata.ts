/**
 * Role connection metadata: the schema registered with Discord
 * (scripts/register-metadata.ts) and the values pushed per user.
 *
 * | Key          | Type                              | Value source                                              |
 * |--------------|-----------------------------------|-----------------------------------------------------------|
 * | merged_prs   | INTEGER_GREATER_THAN_OR_EQUAL (2) | GitHub search: is:pr is:merged org:<org> author:<login>   |
 * | org_member   | BOOLEAN_EQUAL (7)                 | GET /orgs/<org>/members/<login>                           |
 * | maintainer   | BOOLEAN_EQUAL (7)                 | Active member of the maintainer team (default "maintainers") |
 * | owner        | BOOLEAN_EQUAL (7)                 | users.owner in D1; nothing in this repository sets it     |
 *
 * `owner` is always false (0) until the storefront integration writes
 * users.owner = 1 for a verified buyer. This module only reads the column, so
 * a refresh never overwrites a value the storefront set.
 *
 * Discord sends metadata values as strings: integers in decimal, booleans as
 * "1" or "0".
 */
import type { RoleConnectionMetadata } from "../types.ts";

export const RoleConnectionMetadataType = {
  INTEGER_LESS_THAN_OR_EQUAL: 1,
  INTEGER_GREATER_THAN_OR_EQUAL: 2,
  INTEGER_EQUAL: 3,
  INTEGER_NOT_EQUAL: 4,
  DATETIME_LESS_THAN_OR_EQUAL: 5,
  DATETIME_GREATER_THAN_OR_EQUAL: 6,
  BOOLEAN_EQUAL: 7,
  BOOLEAN_NOT_EQUAL: 8,
} as const;

export const PLATFORM_NAME = "GitHub";

export const METADATA_RECORDS: RoleConnectionMetadata[] = [
  {
    type: RoleConnectionMetadataType.INTEGER_GREATER_THAN_OR_EQUAL,
    key: "merged_prs",
    name: "Merged pull requests",
    description: "Pull requests merged in the OpenDrone-hw GitHub organisation",
  },
  {
    type: RoleConnectionMetadataType.BOOLEAN_EQUAL,
    key: "org_member",
    name: "OpenDrone-hw member",
    description: "Member of the OpenDrone-hw GitHub organisation",
  },
  {
    type: RoleConnectionMetadataType.BOOLEAN_EQUAL,
    key: "maintainer",
    name: "Maintainer",
    description: "Member of the OpenDrone-hw maintainer team on GitHub",
  },
  {
    type: RoleConnectionMetadataType.BOOLEAN_EQUAL,
    key: "owner",
    name: "Verified owner",
    description: "Owns an OpenDrone product, verified by the OpenDrone storefront",
  },
];

export interface MetadataValues {
  merged_prs: number;
  org_member: boolean;
  maintainer: boolean;
  owner: boolean;
}

export const EMPTY_METADATA: MetadataValues = { merged_prs: 0, org_member: false, maintainer: false, owner: false };

/** Values in the string form Discord expects, keyed like METADATA_RECORDS. */
export function encodeMetadata(values: MetadataValues): Record<string, string> {
  const count = Number.isFinite(values.merged_prs) ? Math.max(0, Math.floor(values.merged_prs)) : 0;
  return {
    merged_prs: String(count),
    org_member: values.org_member ? "1" : "0",
    maintainer: values.maintainer ? "1" : "0",
    owner: values.owner ? "1" : "0",
  };
}

export interface RoleConnectionBody {
  platform_name: string;
  platform_username?: string;
  metadata: Record<string, string>;
}

/** Body for PUT /users/@me/applications/{app}/role-connection. */
export function roleConnectionBody(githubLogin: string | null, values: MetadataValues): RoleConnectionBody {
  const body: RoleConnectionBody = { platform_name: PLATFORM_NAME, metadata: encodeMetadata(values) };
  if (githubLogin) body.platform_username = githubLogin;
  return body;
}

const KEY = /^[a-z0-9_]{1,50}$/;
const VALID_TYPES = new Set<number>(Object.values(RoleConnectionMetadataType));

/** Problems Discord would reject the schema for; empty when it is valid. */
export function metadataProblems(records: readonly RoleConnectionMetadata[]): string[] {
  const problems: string[] = [];
  if (records.length > 5) problems.push(`${records.length} records exceed Discord's 5`);
  const keys = new Set<string>();
  for (const record of records) {
    const where = `metadata ${JSON.stringify(record.key)}`;
    if (!KEY.test(record.key)) problems.push(`${where}: key must match [a-z0-9_]{1,50}`);
    if (keys.has(record.key)) problems.push(`${where}: duplicate key`);
    keys.add(record.key);
    if (!VALID_TYPES.has(record.type)) problems.push(`${where}: unknown type ${record.type}`);
    if (!record.name || record.name.length > 100) problems.push(`${where}: name must be 1 to 100 characters`);
    if (!record.description || record.description.length > 200) {
      problems.push(`${where}: description must be 1 to 200 characters`);
    }
  }
  return problems;
}
