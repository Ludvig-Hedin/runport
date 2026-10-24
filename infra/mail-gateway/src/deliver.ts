import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import nodemailer from "nodemailer";

// Where accepted mail goes next. "cloudflare" posts it to the sitedock-mail
// Worker (infra/cloudflare-mail), which sends it with Cloudflare Email
// Sending. "ses" sends through Amazon SES. Both use HTTPS, so they work on
// hosts that block outgoing SMTP. "smtp" forwards to another SMTP server,
// used for the test inbox.

export type Envelope = { from: string; to: string[] };
export type Deliver = (envelope: Envelope, raw: Buffer) => Promise<void>;

export function sesDelivery(region: string): Deliver {
  const client = new SESv2Client({ region });
  return async (envelope, raw) => {
    await client.send(
      new SendEmailCommand({
        FromEmailAddress: envelope.from,
        Destination: { ToAddresses: envelope.to },
        Content: { Raw: { Data: raw } },
      }),
    );
  };
}

export function smtpDelivery(host: string, port: number): Deliver {
  const transport = nodemailer.createTransport({ host, port, secure: false, ignoreTLS: true });
  return async (envelope, raw) => {
    await transport.sendMail({ envelope, raw });
  };
}

export class DeliveryError extends Error {
  constructor(
    message: string,
    /** False when retrying cannot help, for example a refused recipient. */
    readonly retry: boolean,
  ) {
    super(message);
  }
}

export function cloudflareDelivery(url: string, token: string): Deliver {
  return async (envelope, raw) => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Mail-From": envelope.from,
        "X-Mail-To": envelope.to.join(","),
        "Content-Type": "message/rfc822",
      },
      body: new Uint8Array(raw),
    });
    if (res.ok) return;
    const detail = await res.text().catch(() => "");
    throw new DeliveryError(`Cloudflare answered ${res.status}: ${detail.slice(0, 300)}`, res.status >= 500 || res.status === 429);
  };
}
