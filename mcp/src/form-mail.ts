import { config } from "./config";
import { readSecret } from "./keychain";

export async function formMailSettings(app: string, url: string, owner?: string): Promise<Record<string, string>> {
  const recipient = (owner || process.env.PLATFORM_FORM_OWNER_EMAIL || await readSecret("appwrite-owner-email")).trim().toLowerCase();
  if (recipient.length > 254 || !/^[a-z\d.!#$%&'*+/=?^_`{|}~-]+@[a-z\d-]+(?:\.[a-z\d-]+)+$/i.test(recipient)) {
    throw new Error("Set PLATFORM_FORM_OWNER_EMAIL to a single valid owner email address.");
  }
  const masterKey = await readSecret("mail-gateway-master-key");
  return {
    RUNPORT_FORM_OWNER_EMAIL: recipient,
    RUNPORT_FORM_MAIL_URL: url,
    RUNPORT_FORM_MAIL_APP: app,
    RUNPORT_FORM_MAIL_FROM: `${app}@${config.mailDomain}`,
    RUNPORT_FORM_MAIL_TOKEN: new Bun.CryptoHasher("sha256", masterKey).update(`form-mail:${app}:${recipient}`).digest("hex"),
  };
}
