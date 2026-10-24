import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import nodemailer from "nodemailer";

// Where accepted mail goes next. "cloudflare" posts it to the sitedock-mail
// Worker (infra/cloudflare-mail), which sends it with Cloudflare Email
// Sending. "ses" sends through Amazon SES. Both use HTTPS, so they work on
// hosts that block outgoing SMTP. "smtp" forwards to another SMTP server,
// used for the test inbox.

export type Envelope = { from: string; to: string[] };
/** Resolves with how many recipients got the message. */
export type Deliver = (envelope: Envelope, raw: Buffer) => Promise<number>;

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
    return envelope.to.length;
  };
}

export function smtpDelivery(host: string, port: number): Deliver {
  const transport = nodemailer.createTransport({ host, port, secure: false, ignoreTLS: true });
  return async (envelope, raw) => {
    await transport.sendMail({ envelope, raw });
    return envelope.to.length;
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

const RETRYABLE = /RATE_LIMIT|DAILY_LIMIT|INTERNAL|DELIVERY_FAILED/;

export function cloudflareDelivery(url: string, token: string): Deliver {
  return async (envelope, raw) => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Mail-From": envelope.from,
        // JSON, so no address can split into extra recipients.
        "X-Mail-To": JSON.stringify(envelope.to),
        "Content-Type": "message/rfc822",
      },
      body: new Uint8Array(raw),
    });
    // Status only in errors: the body could echo addresses.
    if (!res.ok) throw new DeliveryError(`Cloudflare answered ${res.status}`, res.status >= 500 || res.status === 429);
    const result = (await res.json()) as { sent: number; failed: number; codes: string[] };
    if (result.sent > 0) return result.sent;
    throw new DeliveryError(`Cloudflare refused: ${result.codes.join(", ")}`, result.codes.some((c) => RETRYABLE.test(c)));
  };
}
