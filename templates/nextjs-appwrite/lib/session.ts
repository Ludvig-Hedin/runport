import "server-only";
import type { Models } from "node-appwrite";
import { createSessionClient } from "./appwrite";

/** The signed-in user, or null when signed out or the session expired. */
export async function getUser(): Promise<Models.User | null> {
  try {
    const { account } = await createSessionClient();
    return await account.get();
  } catch {
    return null;
  }
}
