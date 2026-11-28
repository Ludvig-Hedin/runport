import { createHmac } from "node:crypto";

/**
 * Appwrite's SMTP settings for an app's login codes: the gateway's dedicated
 * "<slug>:login" identity, whose password is derived from the gateway's
 * master key (Keychain item mail-master-key). Login codes are counted apart
 * from other app mail, so a newsletter can never use up their room.
 */
export function loginSmtp(slug: string, senderName: string, masterKey: string, mailDomain: string) {
  return {
    senderName,
    senderEmail: `${slug}@${mailDomain}`,
    host: "mail-gateway.railway.internal",
    port: 2525,
    username: `${slug}:login`,
    password: createHmac("sha256", masterKey).update(`mail-gateway-login:${slug}`).digest("hex"),
  };
}
