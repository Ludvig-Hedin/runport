import { createHmac, timingSafeEqual } from "node:crypto";

// Who may send, and as whom. Each app has its own SMTP password, derived from
// one master key, so a leaked app password cannot send as another app. Apps
// may only send from <app id>@<allowed domain>. Appwrite itself sends account
// mails for every project, so it may use any address on the allowed domains.

export const APP_ID = /^[a-z0-9][a-z0-9-]{0,35}$/;
export const SYSTEM_SENDER = "appwrite";

export const appPassword = (masterKey: string, app: string) =>
  createHmac("sha256", masterKey).update(`mail-gateway:${app}`).digest("hex");

export function passwordMatches(masterKey: string, app: string, given: string): boolean {
  const expected = Buffer.from(appPassword(masterKey, app));
  const actual = Buffer.from(given);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const parts = (address: string) => {
  const at = address.lastIndexOf("@");
  return { local: address.slice(0, at).toLowerCase(), domain: address.slice(at + 1).toLowerCase() };
};

/** Returns why the app may not use this sender address, or null when it may. */
export function senderProblem(app: string, address: string, allowedDomains: string[]): string | null {
  if (!address.includes("@")) return "Sender address is missing";
  const { local, domain } = parts(address);
  if (allowedDomains.length > 0 && !allowedDomains.includes(domain)) return `Sender domain ${domain} is not allowed`;
  if (app !== SYSTEM_SENDER && local !== app) return `${app} may only send as ${app}@${domain}`;
  return null;
}

/** The address in the message's From header, or null if there is none or more than one. */
export function headerFrom(raw: Buffer): string | null {
  const end = raw.indexOf("\r\n\r\n");
  const head = raw.subarray(0, end === -1 ? raw.length : end).toString("latin1");
  // Unfold continuation lines before looking for the header.
  const lines = head.replace(/\r\n[ \t]+/g, " ").split("\r\n");
  const from = lines.filter((l) => /^from:/i.test(l));
  if (from.length !== 1) return null;
  const value = from[0].slice(5).trim();
  const angle = value.match(/<([^<>\s]+@[^<>\s]+)>/g);
  if (angle) return angle.length === 1 ? angle[0].slice(1, -1).toLowerCase() : null;
  const bare = value.match(/^[^\s,<>]+@[^\s,<>]+$/);
  return bare ? bare[0].toLowerCase() : null;
}
