import { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";
import { DeliveryError, type Deliver } from "./deliver";
import { stockholmDay, type Limits } from "./limits";

const APP = /^[a-z][a-z0-9-]{1,35}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const OWNER_ADDRESS = /^[A-Za-z0-9_+%'-]+(?:\.[A-Za-z0-9_+%'-]+)*@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$/;
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
  exited: "Railway rapporterar att appens process har avslutats.",
};
const hour = 60 * 60_000;
const dayMs = 24 * hour;
const browserIntakePerMinute = 300;
const key = (master: string, purpose: string) => createHmac("sha256", master).update(`runport-app-alerts:${purpose}`).digest("hex");
export const reportKey = (master: string, slug: string, serviceId: string, environmentId: string) =>
  key(master, `report:${slug}:${serviceId}:${environmentId}`);
export const registrationKey = (master: string) => key(master, "register");
export const monitorKey = (master: string) => key(master, "monitor");

type Registration = { slug: string; projectId: string; environmentId: string; serviceId: string; domain: string };
type Deployment = Registration & { registrationId: string; incident: number | null; lastIncident: number | null };
type Report = { source: string; kind: string; fingerprint: string };
type Observation = { slug: string; registrationId: string; serviceId: string; environmentId: string; status: string; reason: string };
type Alert = {
  id: string; registrationId: string; slug: string; detail: string; happened: number; count: number; failures: number;
  category: "error" | "digest" | "down" | "up";
};
type Options = {
  path: string; master: string; owner?: string; limits: Limits; deliver: Deliver;
  log: (entry: Record<string, unknown>) => void; clock?: () => number;
};

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

function registration(value: unknown, slug: string): Registration | undefined {
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
    typeof value.registrationId === "string" && UUID.test(value.registrationId) &&
    typeof value.serviceId === "string" && UUID.test(value.serviceId) &&
    typeof value.environmentId === "string" && UUID.test(value.environmentId) &&
    typeof value.status === "string" && ["down", "up", "sleeping", "unknown", "retired"].includes(value.status) &&
    typeof value.reason === "string" && (value.status !== "down" || Object.hasOwn(downReasons, value.reason));
}

export function createAppAlerts({ path, master, owner, limits, deliver, log, clock = Date.now }: Options) {
  if (!owner || !OWNER_ADDRESS.test(owner) || owner.length > 254) {
    log({ kind: "app-alert", result: "disabled", reason: "ALERT_TO must be one mailbox address" });
    return () => status(503);
  }
  const recipient = owner;
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run(`
    CREATE TABLE IF NOT EXISTS apps (
      slug TEXT PRIMARY KEY, projectId TEXT NOT NULL, environmentId TEXT NOT NULL, serviceId TEXT NOT NULL,
      domain TEXT NOT NULL, incident INTEGER, lastIncident INTEGER, registrationId TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL, category TEXT NOT NULL, detail TEXT NOT NULL,
      happened INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'pending',
      day TEXT NOT NULL, channel TEXT NOT NULL DEFAULT '', due INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0, parent TEXT, registrationId TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS alerts_pending ON alerts(state, happened);
    CREATE TABLE IF NOT EXISTS traffic (
      slug TEXT NOT NULL, channel TEXT NOT NULL, minute INTEGER NOT NULL, count INTEGER NOT NULL,
      PRIMARY KEY (slug, channel)
    );
    CREATE TABLE IF NOT EXISTS monitor_cursor (
      id INTEGER PRIMARY KEY CHECK (id = 1), cursor TEXT NOT NULL DEFAULT '', waitUntil INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO monitor_cursor (id) VALUES (1);
  `);
  // Preserve data if an earlier draft was run against a local store.
  db.transaction(() => {
    const names = (table: "alerts" | "apps") => new Set(
      db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((entry) => entry.name),
    );
    const appColumns = names("apps");
    if (!appColumns.has("lastIncident")) db.run("ALTER TABLE apps ADD COLUMN lastIncident INTEGER");
    if (!appColumns.has("registrationId")) {
      db.run("ALTER TABLE apps ADD COLUMN registrationId TEXT NOT NULL DEFAULT ''");
      for (const { slug } of db.query<{ slug: string }, []>("SELECT slug FROM apps").all()) {
        db.query("UPDATE apps SET registrationId = ? WHERE slug = ?").run(crypto.randomUUID(), slug);
      }
    }
    const columns = names("alerts");
    if (!columns.has("due")) {
      db.run("ALTER TABLE alerts ADD COLUMN due INTEGER NOT NULL DEFAULT 0");
      const old = db.query<{ id: string }, []>("SELECT id FROM alerts WHERE category = 'error'").all();
      for (const { id } of old) db.query(`
        UPDATE alerts SET id = ?, state = CASE WHEN channel = 'browser' THEN 'archived' ELSE state END WHERE id = ?
      `).run(key(master, `fingerprint:${id}`), id);
    }
    if (!columns.has("failures")) db.run("ALTER TABLE alerts ADD COLUMN failures INTEGER NOT NULL DEFAULT 0");
    if (!columns.has("parent")) db.run("ALTER TABLE alerts ADD COLUMN parent TEXT");
    if (!columns.has("registrationId")) {
      db.run("ALTER TABLE alerts ADD COLUMN registrationId TEXT NOT NULL DEFAULT ''");
      // Legacy records did not identify the deployment. Preserve the data,
      // but do not send a queued message on behalf of an unverified service.
      db.run("UPDATE alerts SET state = 'archived' WHERE state = 'pending'");
    }
    db.run("CREATE UNIQUE INDEX IF NOT EXISTS apps_registration ON apps(registrationId)");
    db.run("CREATE INDEX IF NOT EXISTS alerts_registration ON alerts(registrationId, channel, day)");
    db.run("CREATE INDEX IF NOT EXISTS alerts_due ON alerts(state, due)");
  })();

  const intake = db.query<{ count: number }, [string, string, number, number]>(`
    INSERT INTO traffic VALUES (?, ?, ?, 1)
    ON CONFLICT (slug, channel) DO UPDATE SET minute = excluded.minute,
    count = CASE WHEN minute = excluded.minute THEN MIN(count + 1, ?) ELSE 1 END
    RETURNING count
  `);
  const scopedId = (app: Deployment, purpose: string) => `${app.registrationId}:${key(master, purpose)}`;
  const report = db.transaction((app: Deployment, event: Report, now: number): number => {
    const { slug, registrationId } = app;
    if (!db.query("SELECT 1 FROM apps WHERE registrationId = ?").get(registrationId)) return 404;
    const channel = event.source === "browser" ? "browser" : "server";
    const window = Math.floor(now / 60_000);
    if (intake.get(slug, channel, window, 121)!.count > 120) return 429;
    // An empty slug cannot be registered. It holds the shared browser budget
    // on the same SQLite volume as the per-app counters.
    if (channel === "browser" &&
      intake.get("", channel, window, browserIntakePerMinute + 1)!.count > browserIntakePerMinute) return 429;

    const day = stockholmDay(new Date(now));
    if (channel === "browser") {
      // Anonymous reports have a daily summary. Neither the submitted
      // fingerprint nor an individual anonymous event occupies the queue.
      const id = scopedId(app, `browser-digest:${slug}:${day}`);
      db.query(`
        INSERT INTO alerts (id, registrationId, slug, category, detail, happened, day, channel)
        VALUES (?, ?, ?, 'digest', 'Fel i webbläsaren som rapporterats under dagen.', ?, ?, 'browser')
        ON CONFLICT (id) DO UPDATE SET count = count + 1
      `).run(id, registrationId, slug, now, day);
      return 204;
    }
    const id = scopedId(app, `fingerprint:${slug}:${event.source}:${event.kind}:${event.fingerprint}`);
    const existing = db.query("UPDATE alerts SET count = count + 1 WHERE id = ?").run(id);
    if (existing.changes) return 204;

    const budget = db.query<{ count: number }, [string, string, string]>(
      "SELECT COUNT(*) AS count FROM alerts WHERE registrationId = ? AND channel = ? AND day = ?",
    ).get(registrationId, channel, day);
    if (!budget || budget.count >= 5) return 429;
    db.query("INSERT INTO alerts (id, registrationId, slug, category, detail, happened, day, channel) VALUES (?, ?, ?, 'error', ?, ?, ?, ?)")
      .run(id, registrationId, slug, `${sources[event.source]} (${event.kind}).`, now, day, channel);
    return 204;
  });

  const retire = db.transaction((app: Deployment) => {
    db.query("DELETE FROM alerts WHERE registrationId = ?").run(app.registrationId);
    db.query("DELETE FROM traffic WHERE slug = ?").run(app.slug);
    db.query("DELETE FROM apps WHERE registrationId = ?").run(app.registrationId);
  });

  const observe = db.transaction((observations: Observation[], now: number) => {
    for (const { slug, registrationId, serviceId, environmentId, status, reason } of observations) {
      if (status === "unknown") continue;
      const app = db.query<Deployment, [string, string]>("SELECT * FROM apps WHERE slug = ? AND registrationId = ?")
        .get(slug, registrationId);
      if (!app || app.serviceId !== serviceId || app.environmentId !== environmentId) continue;
      if (status === "retired") {
        retire(app);
        continue;
      }
      const day = stockholmDay(new Date(now));
      if (status === "down" && app.incident === null && (app.lastIncident === null || now - app.lastIncident >= hour)) {
        const id = incidentId(app, now);
        db.query("UPDATE apps SET incident = ?, lastIncident = ? WHERE registrationId = ?").run(now, now, registrationId);
        db.query("INSERT INTO alerts (id, registrationId, slug, category, detail, happened, day) VALUES (?, ?, ?, 'down', ?, ?, ?)")
          .run(id, app.registrationId, slug, downReasons[reason], now, day);
      } else if (status === "up" && app.incident !== null) {
        const minutes = Math.max(1, Math.ceil((now - app.incident) / 60_000));
        db.query("UPDATE apps SET incident = NULL WHERE registrationId = ?").run(registrationId);
        const parent = incidentId(app, app.incident);
        db.query("INSERT INTO alerts (id, registrationId, slug, category, detail, happened, day, parent) VALUES (?, ?, ?, 'up', ?, ?, ?, ?)")
          .run(crypto.randomUUID(), app.registrationId, slug, `Appen svarar igen. Avbrottet varade cirka ${minutes} minuter.`, now, day, parent);
      }
    }
  });

  function incidentId(app: Deployment, startedAt: number): string {
    return scopedId(app, `incident:${app.slug}:${app.serviceId}:${startedAt}`);
  }

  async function deliverAlert(event: Alert & Registration) {
      const now = new Date(clock());
      const reservation = limits.reserve(event.slug, "alert", 1, now);
      if (!reservation.ok) {
        db.query("UPDATE alerts SET due = MAX(due, ?) WHERE registrationId = ? AND state = 'pending'")
          .run(now.getTime() + hour, event.registrationId);
        log({ app: event.slug, kind: "app-alert", result: "refused", reason: reservation.reason });
        return;
      }

      // Claim before contacting the provider. A lost acknowledgement is
      // indistinguishable from delivery, so never automatically send it twice.
      const claim = db.query("UPDATE alerts SET state = 'attempted' WHERE id = ? AND state = 'pending'").run(event.id);
      if (!claim.changes) {
        limits.release(event.slug, "alert", 1, now);
        return;
      }

      const title = { error: "Fel i appen", digest: "Daglig sammanfattning av webbläsarfel",
        down: "Appen ligger nere", up: "Appen fungerar igen" }[event.category];
      const subject = `Runport: ${event.slug} | ${title}`;
      const stamp = new Intl.DateTimeFormat("sv-SE", {
        dateStyle: "short", timeStyle: "medium", timeZone: "Europe/Stockholm",
      }).format(event.happened);
      const logs = `https://railway.com/project/${event.projectId}/service/${event.serviceId}?environmentId=${event.environmentId}`;
      const raw = Buffer.from([
        `From: Runport <${SENDER}>`, `To: ${recipient}`,
        `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`,
        `Date: ${now.toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@runport.app>`,
        "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: 8bit",
        "", `App: ${event.slug}`, title, event.detail,
        `Tid: ${stamp} (Stockholm)`, `Antal: ${event.count}`, `Loggar: ${logs}`,
        ...(event.category === "error" ? [`Fel-ID: ${event.id.split(":").at(-1)}`] : []), "",
      ].join("\r\n"));
      try {
        const delivered = await deliver({ from: SENDER, to: [recipient] }, raw);
        if (delivered !== 1) throw new DeliveryError("Delivery was refused", false);
        db.query("UPDATE alerts SET state = 'sent' WHERE id = ?").run(event.id);
        log({ app: event.slug, kind: "app-alert", category: event.category, result: "sent", delivered });
      } catch (error) {
        if (!(error instanceof DeliveryError) || !error.definite) {
          // The cap remains charged if the provider could have accepted it.
          log({ app: event.slug, kind: "app-alert", category: event.category, result: "delivery unconfirmed" });
          return;
        }
        limits.release(event.slug, "alert", 1, now);
        if (error.retry && event.failures < 5) {
          const backoff = 5 * 60_000 * 2 ** event.failures;
          db.query("UPDATE alerts SET state = 'pending', due = ?, failures = failures + 1 WHERE id = ?")
            .run(clock() + backoff, event.id);
          log({ app: event.slug, kind: "app-alert", category: event.category, result: "delivery retry scheduled" });
        } else {
          db.query("UPDATE alerts SET state = 'failed' WHERE id = ?").run(event.id);
          log({ level: "error", app: event.slug, kind: "app-alert", category: event.category,
            result: "owner alert delivery failed", reason: error.message });
        }
      }
  }

  let flushing: Promise<void> | undefined;
  async function flush() {
    const now = clock();
    const today = stockholmDay(new Date(now));
    const deadline = Date.now() + 35_000;
    const eligible = db.query<Alert & Registration, [number, string, number]>(`
      SELECT alerts.id, alerts.registrationId, apps.slug, apps.projectId, apps.environmentId, apps.serviceId, apps.domain,
        alerts.detail, alerts.happened, alerts.count, alerts.category, alerts.failures
      FROM alerts JOIN apps USING (registrationId)
      WHERE state = 'pending' AND due <= ? AND (category != 'digest' OR day < ?)
        AND (parent IS NULL OR EXISTS (SELECT 1 FROM alerts AS incident WHERE incident.id = alerts.parent AND incident.state = 'sent'))
      ORDER BY CASE category WHEN 'down' THEN 0 WHEN 'up' THEN 0 WHEN 'error' THEN 1 ELSE 2 END,
        happened, alerts.rowid LIMIT ?
    `);
    for (let checked = 0; checked < 150 && Date.now() < deadline;) {
      const pending = eligible.all(now, today, Math.min(50, 150 - checked));
      if (!pending.length) break;
      for (const event of pending) {
        if (Date.now() >= deadline) return;
        // An earlier row for a capped app may have deferred this one.
        if (!db.query("SELECT 1 FROM alerts JOIN apps USING (registrationId) WHERE alerts.id = ? AND due <= ? AND state = 'pending'")
          .get(event.id, now)) continue;
        await deliverAlert(event);
      }
      checked += pending.length;
    }
  }

  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === "/internal/app-alerts") {
      if (!authenticated(request, monitorKey(master))) return status(401);
      const now = clock();
      if (request.method === "GET") {
        const cursor = db.query<{ cursor: string; waitUntil: number }, []>("SELECT cursor, waitUntil FROM monitor_cursor WHERE id = 1").get()!;
        if (cursor.waitUntil > now) return Response.json({ apps: [] });
        const page = db.query(`
          SELECT slug, registrationId, projectId, environmentId, serviceId, domain, incident FROM apps WHERE slug > ? ORDER BY slug LIMIT 20
        `);
        const next = page.all(cursor.cursor);
        return Response.json({ apps: next.length ? next : page.all("") });
      }
      if (request.method !== "POST") return status(405);
      const input = await boundedJson(request, 16_000).catch(() => undefined);
      if (!record(input) || !Array.isArray(input.observations) || input.observations.length > 20
        || !input.observations.every(observation)) return status(400);
      const wait = input.retryAfterMs ?? 0;
      if (typeof wait !== "number" || !Number.isSafeInteger(wait) || wait < 0 || wait > 30 * dayMs) return status(400);
      observe.immediate(input.observations, now);
      const last = input.observations.at(-1);
      if (last) db.query("UPDATE monitor_cursor SET cursor = ? WHERE id = 1").run(last.slug);
      if (wait) db.query("UPDATE monitor_cursor SET waitUntil = MAX(waitUntil, ?) WHERE id = 1").run(now + wait);
      db.query(`
        DELETE FROM alerts WHERE happened < ?
          OR (category != 'error' AND happened < ?)
          OR (state = 'pending' AND happened < ?)
      `).run(now - 30 * dayMs, now - 14 * dayMs, now - 7 * dayMs);
      db.query("DELETE FROM traffic WHERE minute < ?").run(Math.floor(now / 60_000) - 60);
      if (!flushing) flushing = flush().finally(() => { flushing = undefined; });
      await flushing;
      const failed = db.query<{ count: number }, []>(`
        SELECT COUNT(*) AS count FROM alerts JOIN apps USING (registrationId)
        WHERE alerts.state IN ('failed', 'refused')
      `).get()!.count;
      return new Response(null, { status: 204, headers: { "X-Runport-Alert-Delivery-Failures": String(failed) } });
    }

    const match = path.match(/^\/_runport\/alerts\/(register|report)\/([a-z][a-z0-9-]{1,35})$/);
    if (!match) return status(404);
    const [, action, slug] = match;
    const retiring = action === "register" && request.method === "DELETE";
    if (request.method !== "POST" && !retiring) return status(405);
    const reportingApp = action === "report" ? db.query<Deployment, [string]>("SELECT * FROM apps WHERE slug = ?").get(slug) : null;
    if (action === "report" && !reportingApp) return status(404);
    const expected = reportingApp ? reportKey(master, slug, reportingApp.serviceId, reportingApp.environmentId) : registrationKey(master);
    if (!authenticated(request, expected)) return status(401);
    const input = await boundedJson(request, 512).catch(() => undefined);
    if (retiring) {
      if (!record(input) || typeof input.serviceId !== "string" || !UUID.test(input.serviceId) ||
        typeof input.environmentId !== "string" || !UUID.test(input.environmentId)) return status(400);
      const existing = db.query<Deployment, [string]>("SELECT * FROM apps WHERE slug = ?").get(slug);
      if (existing && existing.serviceId === input.serviceId && existing.environmentId === input.environmentId) retire(existing);
      return status(204);
    }
    if (action === "register") {
      const app = registration(input, slug);
      if (!app) return status(400);
      db.query(`
        INSERT INTO apps (slug, projectId, environmentId, serviceId, domain, registrationId) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (slug) DO UPDATE SET projectId = excluded.projectId, environmentId = excluded.environmentId,
        serviceId = excluded.serviceId, domain = excluded.domain,
        incident = CASE WHEN serviceId = excluded.serviceId AND environmentId = excluded.environmentId AND projectId = excluded.projectId THEN incident ELSE NULL END,
        lastIncident = CASE WHEN serviceId = excluded.serviceId AND environmentId = excluded.environmentId AND projectId = excluded.projectId THEN lastIncident ELSE NULL END,
        registrationId = CASE WHEN serviceId = excluded.serviceId AND environmentId = excluded.environmentId AND projectId = excluded.projectId
          THEN registrationId ELSE excluded.registrationId END
      `).run(slug, app.projectId, app.environmentId, app.serviceId, app.domain, crypto.randomUUID());
      return status(204);
    }
    const event = errorReport(input);
    return status(event && reportingApp ? report.immediate(reportingApp, event, clock()) : 400);
  };
}
