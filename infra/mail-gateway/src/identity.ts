import { createHmac, timingSafeEqual } from "node:crypto";
import addressparser from "nodemailer/lib/addressparser";

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

/**
 * The single sender address the message shows, or null when it is missing,
 * ambiguous or written in a way mail clients might read differently than we
 * do. Strict on purpose: refusing an odd email is cheaper than letting one
 * app look like another sender.
 */
export function headerFrom(raw: Buffer): string | null {
  const end = raw.indexOf("\r\n\r\n");
  const head = raw.subarray(0, end === -1 ? raw.length : end).toString("latin1");
  // Bare CR or LF can hide a header from us that a client still reads.
  if (/[\r\n]/.test(head.replace(/\r\n/g, ""))) return null;
  const lines = head.replace(/\r\n[ \t]+/g, " ").split("\r\n");
  // Obsolete "Name :" syntax (space before the colon) is read inconsistently.
  if (lines.some((l) => /^[^\s:]+[ \t]+:/.test(l))) return null;
  const values = (name: string) => lines.filter((l) => l.toLowerCase().startsWith(`${name}:`)).map((l) => l.slice(name.length + 1).trim());

  const from = values("from");
  if (from.length !== 1) return null;
  const parsed = addressparser(from[0]);
  if (parsed.length !== 1 || "group" in parsed[0] || !parsed[0].address?.includes("@")) return null;
  // A display name that looks like an address is how lookalike senders work.
  if (parsed[0].name?.includes("@")) return null;
  const address = parsed[0].address.toLowerCase();

  // Sender, when present, overrides From in some clients. Allow it only if equal.
  const sender = values("sender");
  if (sender.length > 1) return null;
  if (sender.length === 1) {
    const s = addressparser(sender[0]);
    if (s.length !== 1 || "group" in s[0] || s[0].address?.toLowerCase() !== address) return null;
  }
  return address;
}
