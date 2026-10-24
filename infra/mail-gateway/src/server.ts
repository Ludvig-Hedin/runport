import { timingSafeEqual } from "node:crypto";
import { SMTPServer, type SMTPServerSession } from "smtp-server";
import type { Config } from "./config";
import type { Deliver } from "./deliver";
import type { Limits } from "./limits";

// SMTP entry point for every email the platform sends: Appwrite's own account
// mails and every app's messages. Each sender logs in with its app id as the
// username, so caps and logs are per app.

const APP_ID = /^[a-z0-9][a-z0-9-]{0,35}$/;

type Log = (entry: Record<string, unknown>) => void;
export const jsonLog: Log = (entry) => console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const smtpError = (message: string, responseCode: number) => Object.assign(new Error(message), { responseCode });

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();

export function createSmtpServer(config: Config, limits: Limits, deliver: Deliver, log: Log = jsonLog): SMTPServer {
  return new SMTPServer({
    // Internal network only. TLS would add nothing and breaks senders that
    // insist on verifying a certificate for an internal hostname.
    disabledCommands: ["STARTTLS"],
    allowInsecureAuth: true,
    authMethods: ["PLAIN", "LOGIN"],
    size: config.maxBytes,
    banner: "builder-platform mail gateway",
    logger: false,

    onAuth(auth, _session, callback) {
      const app = (auth.username ?? "").toLowerCase();
      if (!APP_ID.test(app) || !sameSecret(auth.password ?? "", config.password)) {
        return callback(smtpError("Invalid login", 535));
      }
      callback(null, { user: app });
    },

    onMailFrom(address, session, callback) {
      if (!session.user) return callback(smtpError("Log in first", 530));
      if (config.senderDomains.length > 0 && !config.senderDomains.includes(domainOf(address.address))) {
        return callback(smtpError(`Sender domain ${domainOf(address.address)} is not allowed`, 553));
      }
      callback();
    },

    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("error", (error) => callback(error));
      stream.on("end", () => {
        if (stream.sizeExceeded) return callback(smtpError(`Email is larger than ${config.maxBytes} bytes`, 552));
        handle(session, Buffer.concat(chunks)).then(
          () => callback(),
          (error: Error) => callback(error),
        );
      });
    },
  });

  async function handle(session: SMTPServerSession, raw: Buffer): Promise<void> {
    const app = String(session.user);
    const from = session.envelope.mailFrom ? session.envelope.mailFrom.address : "";
    const to = session.envelope.rcptTo.map((r) => r.address);
    // Checked here rather than per recipient: refusing only the extra
    // recipients would deliver to some and silently drop the rest.
    if (to.length > config.maxRecipients) throw smtpError(`Not sent: at most ${config.maxRecipients} recipients per email`, 550);
    const reservation = limits.reserve(app, to.length);
    if (!reservation.ok) {
      log({ app, recipients: to.length, bytes: raw.length, result: "refused", reason: reservation.reason });
      // Permanent: retrying today would only be refused again.
      throw smtpError(`Not sent: ${reservation.reason}`, 550);
    }
    try {
      await deliver({ from, to }, raw);
      log({ app, recipients: to.length, bytes: raw.length, result: "sent" });
    } catch (error) {
      limits.release(app, to.length);
      log({ app, recipients: to.length, bytes: raw.length, result: "failed", reason: (error as Error).message });
      throw smtpError("Delivery failed, try again later", 451);
    }
  }
}
