import { afterAll, expect, test } from "bun:test";
import nodemailer from "nodemailer";
import { loginSmtp } from "../../../mcp/src/login-smtp";
import type { Config } from "../src/config";
import type { Envelope } from "../src/deliver";
import { Limits } from "../src/limits";
import { createSmtpServer } from "../src/server";

// The SMTP settings deploy-app.ts and deploy-dashboard.ts give Appwrite must
// sign in to the gateway as the app's login identity. Local server, an
// in-memory mailbox, example.test addresses: no real mail leaves.

const PORT = 25261;
const config: Config = {
  masterKey: "master-login-test",
  smtpPort: PORT,
  httpPort: 0,
  dataFile: ":memory:",
  caps: { total: 10, perApp: 10, perAppNews: 10, newsShare: 1, perAppForm: 5, perHourForm: 5, formShare: 0.1, loginReserve: 2, alertTotal: 5, alertPerApp: 2 },
  maxRecipients: 3,
  maxBytes: 20_000,
  senderDomains: ["apps.example.com"],
  delivery: "smtp",
  sesRegion: "eu-north-1",
  forwardHost: "",
  forwardPort: 0,
  cloudflareUrl: "",
  cloudflareToken: "",
};
const mailbox: Envelope[] = [];
const limits = new Limits(":memory:", config.caps);
const server = createSmtpServer(config, limits, async (envelope) => {
  mailbox.push(envelope);
  return envelope.to.length;
}, () => {});
await new Promise<void>((resolve) => server.listen(PORT, resolve));
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const sendAs = (smtp: ReturnType<typeof loginSmtp>) =>
  nodemailer
    .createTransport({ host: "127.0.0.1", port: PORT, secure: false, ignoreTLS: true, auth: { user: smtp.username, pass: smtp.password } })
    .sendMail({ from: smtp.senderEmail, to: "owner@example.test", subject: "Your code", text: "123456" });

test("the dashboard's login settings are accepted as its login identity", async () => {
  const smtp = loginSmtp("dashboard", "Runport", config.masterKey, "apps.example.com");
  expect(smtp.username).toBe("dashboard:login");
  await sendAs(smtp);
  expect(mailbox.at(-1)).toEqual({ from: "dashboard@apps.example.com", to: ["owner@example.test"] });
  expect(limits.today().apps.dashboard?.login).toBe(1);
});

test("a password derived from another master key is refused", async () => {
  const smtp = loginSmtp("dashboard", "Runport", "a-different-master-key", "apps.example.com");
  await expect(sendAs(smtp)).rejects.toThrow();
});
