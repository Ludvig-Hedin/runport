import { SMTPServer, type SMTPServerSession } from "smtp-server";
import type { Config } from "./config";
import type { Deliver } from "./deliver";
import { APP_ID, headerFrom, passwordMatches, senderProblem } from "./identity";
import type { Limits } from "./limits";

// SMTP entry point for every email the platform sends: Appwrite's own account
// mails and every app's messages. Each sender logs in with its app id as the
// username, so caps and logs are per app.

type Log = (entry: Record<string, unknown>) => void;
export const jsonLog: Log = (entry) => console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));

const smtpError = (message: string, responseCode: number) => Object.assign(new Error(message), { responseCode });

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
      if (!APP_ID.test(app) || !passwordMatches(config.masterKey, app, auth.password ?? "")) {
        return callback(smtpError("Invalid login", 535));
      }
      callback(null, { user: app });
    },

    onMailFrom(address, session, callback) {
      if (!session.user) return callback(smtpError("Log in first", 530));
      const problem = senderProblem(String(session.user), address.address, config.senderDomains);
      callback(problem ? smtpError(problem, 553) : undefined);
    },

    onData(stream, session, callback) {
      // Stop keeping chunks once over the limit, but keep reading so the
      // client gets a clean refusal instead of a dropped connection.
      const chunks: Buffer[] = [];
      let bytes = 0;
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes <= config.maxBytes) chunks.push(chunk);
        else chunks.length = 0;
      });
      stream.on("error", (error) => callback(error));
      stream.on("end", () => {
        if (stream.sizeExceeded || bytes > config.maxBytes) return callback(smtpError(`Email is larger than ${config.maxBytes} bytes`, 552));
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
    // The visible From must be the checked envelope sender, or an app could
    // pass the envelope check and still show someone else's address.
    if (headerFrom(raw) !== from.toLowerCase()) throw smtpError("Not sent: the From header must match the sender address", 550);
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
