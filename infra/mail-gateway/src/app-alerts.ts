import { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Deliver } from "./deliver";
import { stockholmDay, type Limits } from "./limits";

const APP = /^[a-z][a-z0-9-]{1,35}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const OWNER = "ludvig@ludvighedin.com";
const SENDER = "alerts@runport.app";
const FINGERPRINT = /^[a-f0-9]{64}$/;
const kinds = new Set(["Error", "TypeError", "ReferenceError", "SyntaxError", "RangeError", "URIError", "EvalError", "AggregateError"]);
const sources: Record<string, string> = {
  render: "Serverfel när sidan skulle visas",
  route: "Serverfel i en API-rutt",
  action: "Serverfel i en serveråtgärd",
  proxy: "Serverfel när en begäran skulle hanteras",
  browser: "Fel i webbläsaren",
};
const downReasons: Record<string, string> = {
  crashed: "Railway rapporterar att appen har kraschat.",
  failed: "Railway kunde inte starta appen.",
  removed: "Railway har ingen aktiv driftsättning för appen.",
  http: "Appens webbadress svarar med ett serverfel.",
  unreachable: "Appens webbadress gick inte att nå.",
};
const key = (master: string, purpose: string) => createHmac("sha256", master).update(`runport-app-alerts:${purpose}`).digest("hex");
export const reportKey = (master: string, slug: string) => key(master, `report:${slug}`);
export const registrationKey = (master: string) => key(master, "register");
export const monitorKey = (master: string) => key(master, "monitor");

type Deployment = { slug: string; projectId: string; environmentId: string; serviceId: string; domain: string; incident: number | null };
type Report = { source: string; kind: string; fingerprint: string };
type Observation = { slug: string; status: string; reason: string };
type Alert = { id: string; slug: string; detail: string; happened: number; count: number; category: "error" | "down" | "up" };
type Options = { path: string; master: string; limits: Limits; deliver: Deliver; log: (entry: Record<string, unknown>) => void };

const status = (code: number) => new Response(null, { status: code });

function authenticated(request: Request, expected: string): boolean {
  const value = request.headers.get("authorization") ?? "";
  return /^Bearer [a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value.slice(7)), Buffer.from(expected));
}

async function boundedJson(request: Request, maxBytes: number): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader || request.headers.get("content-type") !== "application/json") throw new Error("JSON required");
  const bytes = new Uint8Array(maxBytes);
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (size + chunk.value.length > maxBytes) {
      void reader.cancel().catch(() => {});
      throw new Error("Request too large");
    }
    bytes.set(chunk.value, size);
    size += chunk.value.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function registration(value: unknown, slug: string): Omit<Deployment, "incident"> | undefined {
  if (!record(value) || value.slug !== slug) return;
  const { projectId, environmentId, serviceId, domain } = value;
  if (typeof projectId !== "string" || !UUID.test(projectId) ||
    typeof environmentId !== "string" || !UUID.test(environmentId) ||
    typeof serviceId !== "string" || !UUID.test(serviceId) ||
    typeof domain !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}\.up\.railway\.app$/.test(domain)) return;
  return { slug, projectId, environmentId, serviceId, domain };
}

function errorReport(value: unknown): Report | undefined {
  if (!record(value) || Object.keys(value).length !== 3) return;
  const { source, kind, fingerprint } = value;
  if (typeof source !== "string" || !Object.hasOwn(sources, source) ||
    typeof kind !== "string" || !kinds.has(kind) ||
    typeof fingerprint !== "string" || !FINGERPRINT.test(fingerprint)) return;
  return { source, kind, fingerprint };
}

function observation(value: unknown): value is Observation {
  if (!record(value)) return false;
  return typeof value.slug === "string" && APP.test(value.slug) &&
    typeof value.status === "string" && ["down", "up", "sleeping", "unknown"].includes(value.status) &&
    typeof value.reason === "string" && (value.status !== "down" || Object.hasOwn(downReasons, value.reason));
}

export function createAppAlerts({ path, master, limits, deliver, log }: Options) {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run(`
    CREATE TABLE IF NOT EXISTS apps (
      slug TEXT PRIMARY KEY, projectId TEXT NOT NULL, environmentId TEXT NOT NULL, serviceId TEXT NOT NULL,
      domain TEXT NOT NULL, incident INTEGER
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL, category TEXT NOT NULL, detail TEXT NOT NULL,
      happened INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'pending',
      day TEXT NOT NULL, channel TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS alerts_budget ON alerts(slug, channel, day);
    CREATE INDEX IF NOT EXISTS alerts_pending ON alerts(state, happened);
    CREATE TABLE IF NOT EXISTS traffic (
      slug TEXT NOT NULL, channel TEXT NOT NULL, minute INTEGER NOT NULL, count INTEGER NOT NULL,
      PRIMARY KEY (slug, channel)
    );
  `);

  const report = db.transaction((slug: string, event: Report, now: number): number => {
    if (!db.query("SELECT 1 FROM apps WHERE slug = ?").get(slug)) return 404;
    const channel = event.source === "browser" ? "browser" : "server";
    const window = Math.floor(now / 60_000);
    const rate = db.query<{ count: number }, [string, string, number]>(`
      INSERT INTO traffic VALUES (?, ?, ?, 1)
      ON CONFLICT (slug, channel) DO UPDATE SET minute = excluded.minute,
      count = CASE WHEN minute = excluded.minute THEN MIN(count + 1, 121) ELSE 1 END
      RETURNING count
    `).get(slug, channel, window);
    if (!rate || rate.count > 120) return 429;

    const id = [slug, event.source, event.kind, event.fingerprint].join(":");
    const existing = db.query("UPDATE alerts SET count = count + 1 WHERE id = ?").run(id);
    if (existing.changes) return 204;

    const day = stockholmDay(new Date(now));
    const budget = db.query<{ count: number }, [string, string, string]>(
      "SELECT COUNT(*) AS count FROM alerts WHERE slug = ? AND channel = ? AND day = ?",
    ).get(slug, channel, day);
    if (!budget || budget.count >= 5) return 429;
    db.query("INSERT INTO alerts (id, slug, category, detail, happened, day, channel) VALUES (?, ?, 'error', ?, ?, ?, ?)")
      .run(id, slug, `${sources[event.source]} (${event.kind}).`, now, day, channel);
    return 204;
  });

  const observe = db.transaction((observations: Observation[], now: number) => {
    for (const { slug, status, reason } of observations) {
      const app = db.query<Deployment, [string]>("SELECT * FROM apps WHERE slug = ?").get(slug);
      if (!app || status === "unknown") continue;
      const day = stockholmDay(new Date(now));
      if (status === "down" && app.incident === null) {
        const id = crypto.randomUUID();
        db.query("UPDATE apps SET incident = ? WHERE slug = ?").run(now, slug);
        db.query("INSERT INTO alerts (id, slug, category, detail, happened, day) VALUES (?, ?, 'down', ?, ?, ?)")
          .run(id, slug, downReasons[reason], now, day);
      } else if ((status === "up" || status === "sleeping") && app.incident !== null) {
        const minutes = Math.max(1, Math.ceil((now - app.incident) / 60_000));
        db.query("UPDATE apps SET incident = NULL WHERE slug = ?").run(slug);
        db.query("INSERT INTO alerts (id, slug, category, detail, happened, day) VALUES (?, ?, 'up', ?, ?, ?)")
          .run(crypto.randomUUID(), slug, `Appen svarar igen. Avbrottet varade cirka ${minutes} minuter.`, now, day);
      }
    }
  });

  async function flush() {
    const pending = db.query<Alert, []>(`
      SELECT id, slug, detail, happened, count, category FROM alerts WHERE state = 'pending'
      ORDER BY category = 'error', happened, rowid LIMIT 50
    `).all();
    const capped = new Set<string>();
    for (const event of pending) {
      if (capped.has(event.slug)) continue;
      const app = db.query<Deployment, [string]>("SELECT * FROM apps WHERE slug = ?").get(event.slug);
      if (!app) continue;
      const now = new Date();
      const reservation = limits.reserve(event.slug, "mail", 1, now);
      if (!reservation.ok) {
        capped.add(event.slug);
        log({ app: app.slug, kind: "app-alert", result: "refused", reason: reservation.reason });
        continue;
      }

      // Claim before contacting the provider. A lost acknowledgement is
      // indistinguishable from delivery, so never automatically send it twice.
      const claim = db.query("UPDATE alerts SET state = 'attempted' WHERE id = ? AND state = 'pending'").run(event.id);
      if (!claim.changes) {
        limits.release(event.slug, "mail", 1, now);
        continue;
      }

      const title = { error: "Fel i appen", down: "Appen ligger nere", up: "Appen fungerar igen" }[event.category];
      const subject = `Runport: ${app.slug} | ${title}`;
      const stamp = new Intl.DateTimeFormat("sv-SE", {
        dateStyle: "short", timeStyle: "medium", timeZone: "Europe/Stockholm",
      }).format(event.happened);
      const logs = `https://railway.com/project/${app.projectId}/service/${app.serviceId}?environmentId=${app.environmentId}`;
      const raw = Buffer.from([
        `From: Runport <${SENDER}>`, `To: ${OWNER}`,
        `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
        `Date: ${now.toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@runport.app>`,
        "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit",
        "", `App: ${app.slug}`, title, event.detail,
        `Tid: ${stamp} (Stockholm)`, `Antal: ${event.count}`, `Loggar: ${logs}`,
        ...(event.category === "error" ? [`Fel-ID: ${event.id.split(":").at(-1)}`] : []), "",
      ].join("\r\n"));
      try {
        const delivered = await deliver({ from: SENDER, to: [OWNER] }, raw);
        if (delivered !== 1) throw new Error("Delivery was refused");
        db.query("UPDATE alerts SET state = 'sent' WHERE id = ?").run(event.id);
        log({ app: app.slug, kind: "app-alert", category: event.category, result: "sent", delivered });
      } catch {
        // The cap remains charged for an ambiguous delivery, since the owner
        // could already have received the message.
        log({ app: app.slug, kind: "app-alert", category: event.category, result: "delivery unconfirmed" });
      }
    }
  }

  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === "/internal/app-alerts") {
      if (!authenticated(request, monitorKey(master))) return status(401);
      if (request.method === "GET") return Response.json(db.query(
        "SELECT slug, projectId, environmentId, serviceId, domain FROM apps ORDER BY slug",
      ).all());
      if (request.method !== "POST") return status(405);
      const input = await boundedJson(request, 256_000).catch(() => undefined);
      if (!Array.isArray(input) || !input.every(observation)) return status(400);
      observe(input, Date.now());
      await flush();
      return status(204);
    }

    const match = path.match(/^\/_runport\/alerts\/(register|report)\/([a-z][a-z0-9-]{1,35})$/);
    if (!match) return status(404);
    if (request.method !== "POST") return status(405);
    const [, action, slug] = match;
    const expected = action === "register" ? registrationKey(master) : reportKey(master, slug);
    if (!authenticated(request, expected)) return status(401);
    const input = await boundedJson(request, 512).catch(() => undefined);
    if (action === "register") {
      const app = registration(input, slug);
      if (!app) return status(400);
      db.query(`
        INSERT INTO apps (slug, projectId, environmentId, serviceId, domain) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (slug) DO UPDATE SET projectId = excluded.projectId, environmentId = excluded.environmentId,
        serviceId = excluded.serviceId, domain = excluded.domain,
        incident = CASE WHEN serviceId = excluded.serviceId AND environmentId = excluded.environmentId THEN incident ELSE NULL END
      `).run(slug, app.projectId, app.environmentId, app.serviceId, app.domain);
      return status(204);
    }
    const event = errorReport(input);
    return status(event ? report(slug, event, Date.now()) : 400);
  };
}
