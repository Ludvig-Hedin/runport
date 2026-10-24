import { S3Client } from "bun";

// Shared by backup.ts and monitor.ts. Both run as Railway cron jobs.

export const bucket = new S3Client({
  accessKeyId: required("S3_ACCESS_KEY_ID"),
  secretAccessKey: required("S3_SECRET_ACCESS_KEY"),
  bucket: required("S3_BUCKET"),
  endpoint: required("S3_ENDPOINT"),
  region: process.env.S3_REGION || "auto",
});

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

/**
 * Emails the owner through the Cloudflare mail Worker directly, not through
 * the mail gateway, so alerts still go out when the gateway is the problem.
 */
export async function alertOwner(subject: string, text: string): Promise<void> {
  const from = "alerts@runport.app";
  const to = required("ALERT_TO");
  const raw = [
    `From: Sitedock <${from}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <${crypto.randomUUID()}@runport.app>`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    text,
    "",
  ].join("\r\n");
  const res = await fetch(required("CLOUDFLARE_MAIL_URL"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${required("CLOUDFLARE_MAIL_TOKEN")}`,
      "X-Mail-From": from,
      "X-Mail-To": JSON.stringify([to]),
      "Content-Type": "message/rfc822",
    },
    body: raw,
  });
  if (!res.ok) throw new Error(`Alert mail failed: ${res.status} ${await res.text()}`);
}
