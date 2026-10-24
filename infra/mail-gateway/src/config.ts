// All settings come from the environment, see ../README.md.

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
};

const positiveInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number, got "${raw}".`);
  return value;
};

const list = (name: string): string[] =>
  (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

export function loadConfig() {
  const delivery = process.env.DELIVERY ?? "smtp";
  if (delivery !== "ses" && delivery !== "smtp") throw new Error(`DELIVERY must be "ses" or "smtp", got "${delivery}".`);
  return {
    /** Each app's SMTP password is derived from this key, see identity.ts. */
    masterKey: required("GATEWAY_MASTER_KEY"),
    smtpPort: positiveInt("SMTP_PORT", 2525),
    httpPort: positiveInt("HTTP_PORT", 8080),
    dataFile: process.env.DATA_FILE ?? "/data/limits.sqlite",
    caps: { total: positiveInt("MAIL_DAILY_LIMIT", 1000), perApp: positiveInt("MAIL_APP_DAILY_LIMIT", 300) },
    maxRecipients: positiveInt("MAX_RECIPIENTS", 50),
    maxBytes: positiveInt("MAX_BYTES", 10 * 1024 * 1024),
    /** Sender domains allowed in MAIL FROM. Empty allows any, for local testing only. */
    senderDomains: list("SENDER_DOMAINS"),
    delivery,
    sesRegion: process.env.AWS_REGION ?? "eu-north-1",
    forwardHost: process.env.FORWARD_HOST ?? "mailpit",
    forwardPort: positiveInt("FORWARD_PORT", 1025),
  } as const;
}

export type Config = ReturnType<typeof loadConfig>;
