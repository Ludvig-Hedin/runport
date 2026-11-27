import "server-only";
import { getUser } from "./session";
import { OWNER_COLUMN } from "./schema";

/**
 * The owner field for a new row in a `personal` table, taken from the
 * signed-in session on the server. Never accept an owner from a form.
 */
export async function ownerData(): Promise<Record<typeof OWNER_COLUMN, string>> {
  const user = await getUser();
  if (!user) throw new Error("Not signed in");
  return { [OWNER_COLUMN]: user.$id };
}
