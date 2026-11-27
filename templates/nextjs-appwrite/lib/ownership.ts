// Which rows belong to exactly one person. Used by `bun run setup` to give
// older rows their owner, so it imports nothing Next-specific.

import { OWNER_COLUMN } from "./schema";

type Row = { $id: string; $permissions: string[] } & Record<string, unknown>;

const ROLE = /^[a-z]+\("([^"]+)"\)$/;
const USER_ROLE = /^user:([A-Za-z0-9._-]+)(\/[a-z]+)?$/;

/**
 * The one person every permission on this row names, or null when the row is
 * shared in any way (another user, a team, a member, a label, any, guests or
 * all users) or the permissions cannot be read.
 */
export function soleOwner(permissions: string[]): string | null {
  let owner: string | null = null;
  for (const permission of permissions) {
    const role = ROLE.exec(permission)?.[1];
    const user = role ? USER_ROLE.exec(role)?.[1] : undefined;
    if (!user) return null;
    if (owner && owner !== user) return null;
    owner = user;
  }
  return owner;
}

/**
 * A row is someone's only when the server-set owner column names them AND
 * the row's permissions name nobody else. Shared rows never count, whatever
 * the owner column says.
 */
export const isSolelyOwnedBy = (row: Row, userId: string) =>
  row[OWNER_COLUMN] === userId && soleOwner(row.$permissions) === userId;
