import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import nodemailer from "nodemailer";

// Where accepted mail goes next. "cloudflare" posts it to the runport-mail
// Worker (infra/cloudflare-mail), which sends it with Cloudflare Email
// Sending. "ses" sends through Amazon SES. Both use HTTPS, so they work on
// hosts that block outgoing SMTP. "smtp" forwards to another SMTP server,
// used for the test inbox.

export type Envelope = { from: string; to: string[] };
/** Resolves with how many recipients got the message. */
export type Deliver = (envelope: Envelope, raw: Buffer) => Promise<number>;

export function sesDelivery(
  region: string,
  client: { send(command: SendEmailCommand, options: { abortSignal: AbortSignal }): Promise<unknown> } =
    new SESv2Client({ region, maxAttempts: 1 }),
): Deliver {
  return async (envelope, raw) => {
    try {
      await client.send(
        new SendEmailCommand({
          FromEmailAddress: envelope.from,
          Destination: { ToAddresses: envelope.to },
          Content: { Raw: { Data: raw } },
        }),
        { abortSignal: AbortSignal.timeout(8000) },
      );
    } catch (error) {
      const response = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
      const code = response?.$metadata?.httpStatusCode;
      if (code === 429 || /^(?:TooManyRequestsException|ThrottlingException)$/.test(response?.name ?? "")) {
        throw new DeliveryError("SES throttled the message", true);
      }
      if (code === 408 || (code && code >= 500)) {
        // SES may have accepted the message before a timeout or server error.
        throw new DeliveryError("SES delivery outcome is unknown", true, false);
      }
      if (code && code >= 400) throw new DeliveryError(`SES refused with ${code}`, false);
      throw error;
    }
    return envelope.to.length;
  };
}

export function smtpDelivery(host: string, port: number): Deliver {
  const transport = nodemailer.createTransport({ host, port, secure: false, ignoreTLS: true });
  return async (envelope, raw) => {
    try {
      await transport.sendMail({ envelope, raw });
    } catch (error) {
      const code = (error as { responseCode?: number })?.responseCode;
      if (code && code >= 400 && code < 600) throw new DeliveryError(`SMTP refused with ${code}`, code < 500);
      throw error;
    }
    return envelope.to.length;
  };
}

export class DeliveryError extends Error {
  constructor(
    message: string,
    /** False when retrying cannot help, for example a refused recipient. */
    readonly retry: boolean,
    readonly definite = true,
  ) {
    super(message);
  }
}

const RETRYABLE = /RATE_LIMIT|DAILY_LIMIT|INTERNAL|DELIVERY_FAILED/;

export function cloudflareDelivery(url: string, token: string): Deliver {
  return async (envelope, raw) => {
    const res = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(8000),
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
    if (!res.ok) throw new DeliveryError(`Cloudflare answered ${res.status}`, res.status >= 500 || res.status === 429, res.status < 500);
    const result = (await res.json()) as { sent: number; failed: number; codes: string[] };
    if (result.sent > 0) return result.sent;
    const uncertain = result.codes.some((code) => /INTERNAL|DELIVERY_FAILED|UNKNOWN/.test(code));
    throw new DeliveryError(`Cloudflare refused: ${result.codes.join(", ")}`, result.codes.some((c) => RETRYABLE.test(c)), !uncertain);
  };
}
