// Who may use the dashboard, as plain functions (tested in test/owner.test.ts).

export function ownerEmails(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isOwnerEmail(email: string, raw: string | undefined): boolean {
  return ownerEmails(raw).includes(email.trim().toLowerCase());
}

export type AccessState = "signed-out" | "no-access" | "owner";

/** A verified email on the list is the owner; any other account gets no access. */
export function accessFor(user: { email: string; emailVerification: boolean } | null, raw: string | undefined): AccessState {
  if (!user) return "signed-out";
  return user.emailVerification && isOwnerEmail(user.email, raw) ? "owner" : "no-access";
}
