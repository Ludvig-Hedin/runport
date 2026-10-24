import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import nodemailer, { type SendMailOptions } from "nodemailer";
import type { Config } from "../src/config";
import type { Envelope } from "../src/deliver";
import { Limits, stockholmDay } from "../src/limits";
import { createSmtpServer } from "../src/server";

describe("Limits", () => {
  test("counts recipients per app and in total", () => {
    const limits = new Limits(":memory:", { total: 5, perApp: 3 });
    expect(limits.reserve("a", 3).ok).toBe(true);
    expect(limits.reserve("a", 1)).toEqual({ ok: false, reason: "daily limit of 3 emails for a reached" });
    expect(limits.reserve("b", 2).ok).toBe(true);
    expect(limits.reserve("c", 1)).toEqual({ ok: false, reason: "daily limit of 5 emails for all apps reached" });
    expect(limits.today().total).toBe(5);
  });

  test("a refused reservation counts nothing", () => {
    const limits = new Limits(":memory:", { total: 10, perApp: 2 });
    expect(limits.reserve("a", 3).ok).toBe(false);
    expect(limits.today().total).toBe(0);
  });

  test("release gives the cap back and never goes below zero", () => {
    const limits = new Limits(":memory:", { total: 10, perApp: 2 });
    limits.reserve("a", 2);
    limits.release("a", 5);
    expect(limits.today().apps.a).toBe(0);
    expect(limits.reserve("a", 2).ok).toBe(true);
  });

  test("resets at Stockholm midnight, not UTC midnight", () => {
    const limits = new Limits(":memory:", { total: 1, perApp: 1 });
    // 23:30 UTC on 1 July is 01:30 the next day in Stockholm (summer time).
    const lateUtc = new Date("2026-07-01T23:30:00Z");
    expect(stockholmDay(lateUtc)).toBe("2026-07-02");
    expect(limits.reserve("a", 1, new Date("2026-07-01T21:00:00Z")).ok).toBe(true);
    expect(limits.reserve("a", 1, lateUtc).ok).toBe(true);
  });
});

const PORT = 25250;
const config: Config = {
  password: "secret-test",
  smtpPort: PORT,
  httpPort: 0,
  dataFile: ":memory:",
  caps: { total: 4, perApp: 3 },
  maxRecipients: 3,
  maxBytes: 20_000,
  senderDomains: ["apps.example.com"],
  delivery: "smtp",
  sesRegion: "eu-north-1",
  forwardHost: "",
  forwardPort: 0,
};

let delivered: Envelope[] = [];
let failNext = false;
let limits = new Limits(":memory:", config.caps);
const server = createSmtpServer(
  config,
  { reserve: (...a) => limits.reserve(...a), release: (...a) => limits.release(...a), today: () => limits.today() } as Limits,
  async (envelope) => {
    if (failNext) {
      failNext = false;
      throw new Error("provider down");
    }
    delivered.push(envelope);
  },
  () => {},
);
await new Promise<void>((resolve) => server.listen(PORT, resolve));
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const client = (user: string, pass = config.password) =>
  nodemailer.createTransport({ host: "127.0.0.1", port: PORT, secure: false, ignoreTLS: true, auth: { user, pass } });

const send = (user: string, to: string[], extra: Partial<SendMailOptions> = {}, pass?: string) =>
  client(user, pass).sendMail({ from: "noreply@apps.example.com", to, subject: "Hi", text: "Hello", ...extra });

const smtpCode = (promise: Promise<unknown>) =>
  promise.then(
    () => 0,
    (e: { responseCode?: number }) => e.responseCode ?? -1,
  );

describe("SMTP gateway", () => {
  beforeEach(() => {
    delivered = [];
    failNext = false;
    limits = new Limits(":memory:", config.caps);
  });

  test("delivers and counts per app", async () => {
    await send("todo", ["a@x.com", "b@x.com"]);
    expect(delivered).toEqual([{ from: "noreply@apps.example.com", to: ["a@x.com", "b@x.com"] }]);
    expect(limits.today().apps.todo).toBe(2);
  });

  test("refuses a wrong password", async () => {
    expect(await smtpCode(send("todo", ["a@x.com"], {}, "wrong"))).toBe(535);
    expect(delivered).toEqual([]);
  });

  test("refuses usernames that are not app ids", async () => {
    expect(await smtpCode(send("../etc", ["a@x.com"]))).toBe(535);
  });

  test("refuses senders outside the allowed domains", async () => {
    expect(await smtpCode(send("todo", ["a@x.com"], { from: "ceo@bank.com" }))).toBe(553);
  });

  test("stops at the per-app cap and sends nothing over it", async () => {
    await send("todo", ["a@x.com", "b@x.com", "c@x.com"]);
    expect(await smtpCode(send("todo", ["d@x.com"]))).toBe(550);
    expect(delivered.length).toBe(1);
  });

  test("stops at the total cap across apps", async () => {
    await send("todo", ["a@x.com", "b@x.com", "c@x.com"]);
    expect(await smtpCode(send("shop", ["d@x.com", "e@x.com"]))).toBe(550);
    await send("shop", ["d@x.com"]);
    expect(limits.today().total).toBe(4);
  });

  test("limits recipients per email", async () => {
    expect(await smtpCode(send("todo", ["a@x.com", "b@x.com", "c@x.com", "d@x.com"]))).toBe(550);
    expect(delivered).toEqual([]);
  });

  test("refuses oversized emails", async () => {
    expect(await smtpCode(send("todo", ["a@x.com"], { text: "x".repeat(30_000) }))).toBe(552);
    expect(limits.today().total).toBe(0);
  });

  test("a failed delivery asks the sender to retry and does not use the cap", async () => {
    failNext = true;
    expect(await smtpCode(send("todo", ["a@x.com"]))).toBe(451);
    expect(limits.today().apps.todo).toBe(0);
  });
});
