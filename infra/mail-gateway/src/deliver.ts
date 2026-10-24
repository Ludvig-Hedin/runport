import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import nodemailer from "nodemailer";

// Where accepted mail goes next. "ses" sends through Amazon SES over HTTPS, so
// it also works on hosts that block outgoing SMTP. "smtp" forwards to another
// SMTP server, used for the local test inbox.

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
