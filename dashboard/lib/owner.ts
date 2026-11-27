import "server-only";
import type { Models } from "node-appwrite";
import { getUser } from "./session";

// Only the owner may see or run the dashboard. DASHBOARD_OWNER_EMAILS is a
// comma-separated list; when it is empty nobody gets in.

export function ownerEmails(): string[] {
  return (process.env.DASHBOARD_OWNER_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isOwnerEmail(email: string): boolean {
  return ownerEmails().includes(email.trim().toLowerCase());
}

export type Access = { state: "signed-out" } | { state: "no-access"; user: Models.User } | { state: "owner"; user: Models.User };

export async function access(): Promise<Access> {
  const user = await getUser();
  if (!user) return { state: "signed-out" };
  // A verified email is required, so an account cannot claim the owner's address unconfirmed.
  if (!user.emailVerification || !isOwnerEmail(user.email)) return { state: "no-access", user };
  return { state: "owner", user };
}

/** For route handlers: the owner, or a 401/403 response. */
export async function ownerOrResponse(): Promise<{ user: Models.User } | { response: Response }> {
  const result = await access();
  if (result.state === "owner") return { user: result.user };
  return { response: Response.json({ error: "No access" }, { status: result.state === "signed-out" ? 401 : 403 }) };
}
