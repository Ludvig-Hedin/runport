import type { Database } from "bun:sqlite";

const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const eventKinds = new Map<string, EventKind>([
  ["Deployment.deployed", "success"], ["Deployment.restarted", "success"], ["Deployment.crashed", "crashed"],
  ["Deployment.failed", "failed"], ["Deployment.removed", "removed"],
]);
const day = 86_400_000;
type EventKind = "success" | "crashed" | "failed" | "removed";
type Registration = {
  slug: string; registrationId: string; projectId: string; environmentId: string;
  serviceId: string; domain: string; registeredAt: number;
};
type Signal = Registration & { happened: number; kind: EventKind };
type Observation = Pick<Registration, "slug" | "registrationId" | "serviceId" | "environmentId"> & {
  status: "up" | "down"; reason: string;
};
type Probe = (domain: string) => Promise<boolean>;

export async function probeRailwayApp(domain: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await Bun.sleep(1500);
    try {
      const { status } = await fetch(`https://${domain}/`, {
        method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(4500),
      });
      if (status >= 200 && status < 400 || status === 401 || status === 403) return true;
    } catch {
      // The second attempt gives a cold Railway instance time to wake.
    }
  }
  return false;
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

export function railwayWebhooks(db: Database, probe: Probe) {
  db.run(`
    CREATE TABLE IF NOT EXISTS railway_signals (
      registrationId TEXT PRIMARY KEY, happened INTEGER NOT NULL, kind TEXT NOT NULL,
      successfulDeployment TEXT, pending INTEGER NOT NULL, nextCheck INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS railway_signals_pending ON railway_signals(pending, nextCheck, happened);
  `);
  const queue = db.query(`
    INSERT INTO railway_signals VALUES (?, ?, ?, ?, 1, ?)
    ON CONFLICT (registrationId) DO UPDATE SET happened = excluded.happened, kind = excluded.kind,
      successfulDeployment = COALESCE(excluded.successfulDeployment, railway_signals.successfulDeployment),
      pending = 1, nextCheck = excluded.nextCheck
    WHERE excluded.happened > railway_signals.happened
      AND (excluded.kind != 'removed' OR railway_signals.successfulDeployment IS NULL OR railway_signals.successfulDeployment = ?)
  `);

  function receive(app: Registration, payload: unknown, now: number) {
    const type = field(payload, "type");
    const kind = typeof type === "string" ? eventKinds.get(type) : undefined;
    if (!kind) return;
    const timestamp = field(payload, "timestamp");
    const happened = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
    if (!Number.isFinite(happened) || happened < app.registeredAt || happened < now - day || happened > now + 60_000) return;
    const resource = field(payload, "resource");
    const id = (name: string) => field(field(resource, name), "id");
    const deployment = id("deployment");
    if (id("project") !== app.projectId || id("environment") !== app.environmentId || id("service") !== app.serviceId ||
        typeof deployment !== "string" || !idPattern.test(deployment)) return;
    // A request can outlive a concurrent re-registration while reading its
    // body. Keep its authenticated event tied to the original generation.
    if (!db.query("SELECT 1 FROM apps WHERE registrationId = ?").get(app.registrationId)) return;
    return queue.run(app.registrationId, happened, kind, kind === "success" ? deployment : null, now, deployment).changes > 0;
  }

  async function process(now: number, observe: (updates: Observation[], now: number) => unknown, registrationId: string | null = null) {
    const list = db.query<Signal, [number, number, string | null, string | null]>(`
      SELECT apps.*, railway_signals.happened, railway_signals.kind FROM railway_signals
      JOIN apps USING (registrationId) WHERE pending = 1 AND nextCheck <= ? AND happened >= ?
      AND (? IS NULL OR registrationId = ?)
      ORDER BY nextCheck, happened LIMIT 20
    `).all(now, now - day, registrationId, registrationId);
    const checked = await Promise.all(list.map(async app => ({ app, healthy: await probe(app.domain) })));
    const finish = db.transaction(() => {
      const updates: Observation[] = [];
      for (const { app, healthy } of checked) {
        const retry = !healthy && app.kind === "success";
        const changed = db.query(`
          UPDATE railway_signals SET pending = ?, nextCheck = ?
          WHERE registrationId = ? AND happened = ? AND pending = 1 RETURNING registrationId
        `).get(retry ? 1 : 0, retry ? now + 60_000 : now, app.registrationId, app.happened);
        if (changed && !retry) updates.push({
          slug: app.slug, registrationId: app.registrationId, serviceId: app.serviceId, environmentId: app.environmentId,
          status: healthy ? "up" : "down", reason: healthy ? "" : app.kind,
        });
      }
      observe(updates, now);
      if (!registrationId) {
        db.query("DELETE FROM railway_signals WHERE NOT EXISTS (SELECT 1 FROM apps WHERE apps.registrationId = railway_signals.registrationId)").run();
      }
      return updates.length;
    });
    return finish.immediate();
  }
  return { receive, process };
}
