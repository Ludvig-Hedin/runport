import "server-only";
import { Permission, Role } from "node-appwrite";
import { getUser } from "./session";
import { OWNER_COLUMN } from "./schema";

/**
 * The owner and permissions for a new personal row come from the session.
 * Keep both fixed for the life of the row.
 */
export async function ownerData() {
  const user = await getUser();
  if (!user) throw new Error("Not signed in");
  const owner = Role.user(user.$id);
  return {
    data: { [OWNER_COLUMN]: user.$id },
    permissions: [Permission.read(owner), Permission.update(owner), Permission.delete(owner)],
  };
}
