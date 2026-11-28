import "server-only";
import type { Models } from "node-appwrite";
import { accessFor, isOwnerEmail as isOwner } from "./owner-rules";
import { getUser } from "./session";

// Only the owner may see or run the dashboard. DASHBOARD_OWNER_EMAILS is a
// comma-separated list; when it is empty nobody gets in.

export const isOwnerEmail = (email: string) => isOwner(email, process.env.DASHBOARD_OWNER_EMAILS);

export type Access = { state: "signed-out" } | { state: "no-access"; user: Models.User } | { state: "owner"; user: Models.User };

export async function access(): Promise<Access> {
  const user = await getUser();
  const state = accessFor(user, process.env.DASHBOARD_OWNER_EMAILS);
  if (state === "signed-out" || !user) return { state: "signed-out" };
  return { state, user };
}

/** For route handlers: the owner, or a 401/403 response. */
export async function ownerOrResponse(): Promise<{ user: Models.User } | { response: Response }> {
  const result = await access();
  if (result.state === "owner") return { user: result.user };
  return { response: Response.json({ error: "No access" }, { status: result.state === "signed-out" ? 401 : 403 }) };
}
