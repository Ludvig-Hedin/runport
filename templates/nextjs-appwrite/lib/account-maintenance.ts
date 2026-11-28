import { createHash, timingSafeEqual } from "node:crypto";

export const ACCOUNT_MAINTENANCE_PATH = "/api/runport/account-maintenance";

export function authorisedMaintenance(header: string | null, key = process.env.RUNPORT_ACCOUNT_MAINTENANCE_KEY): boolean {
  if (!header || !key) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header), digest(`Bearer ${key}`));
}
