import type { Database } from "bun:sqlite";

const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const eventKinds = new Map<string, EventKind>([
  ["Deployment.deployed", "success"], ["Deployment.restarted", "success"], ["Deployment.crashed", "crashed"],
  ["Deployment.failed", "failed"], ["Deployment.removed", "removed"],
]);
const day = 86_400_000;
const grace = 60_000;
const probeConcurrency = 4;
type EventKind = "success" | "crashed" | "failed" | "removed";
type Registration = {
  slug: string; registrationId: string; projectId: string; environmentId: string;
  serviceId: string; domain: string; registeredAt: number;
};
type Signal = Registration & { deploymentId: string; happened: number; kind: EventKind; firstFailure: number | null };
type Observation = Pick<Registration, "slug" | "registrationId" | "serviceId" | "environmentId"> & {
  status: "up" | "down"; reason: string;
};
type Probe = (domain: string) => Promise<boolean>;
type Observe = (updates: Observation[], now: number) => unknown;

export async function probeRailwayApp(domain: string): Promise<boolean> {
  try {
    const { status } = await fetch(`https://${domain}/`, {
      method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(4500),
    });
    return status >= 200 && status < 400 || status === 401 || status === 403;
  } catch {
    return false;
  }
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

export function railwayWebhooks(db: Database, probe: Probe, clock: () => number) {
  db.run(`
    CREATE TABLE IF NOT EXISTS railway_deployments (
      registrationId TEXT NOT NULL, deploymentId TEXT NOT NULL, happened INTEGER NOT NULL,
      kind TEXT NOT NULL, successfulAt INTEGER,
      PRIMARY KEY (registrationId, deploymentId)
    );
    CREATE INDEX IF NOT EXISTS railway_deployments_success ON railway_deployments(registrationId, successfulAt);
    CREATE TABLE IF NOT EXISTS railway_checks (
      registrationId TEXT PRIMARY KEY, deploymentId TEXT NOT NULL, happened INTEGER NOT NULL,
      kind TEXT NOT NULL, pending INTEGER NOT NULL, nextCheck INTEGER NOT NULL, firstFailure INTEGER
    );
    CREATE INDEX IF NOT EXISTS railway_checks_pending ON railway_checks(pending, nextCheck, happened);
  `);
  const recordEvent = db.transaction((registrationId: string, deploymentId: string, happened: number, kind: EventKind, now: number) => {
    if (!db.query("SELECT 1 FROM apps WHERE registrationId = ?").get(registrationId)) return;
    db.query(`
      INSERT INTO railway_deployments VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (registrationId, deploymentId) DO UPDATE SET
        kind = CASE WHEN excluded.happened > happened THEN excluded.kind ELSE kind END,
        happened = MAX(happened, excluded.happened),
        successfulAt = NULLIF(MAX(COALESCE(successfulAt, 0), COALESCE(excluded.successfulAt, 0)), 0)
    `).run(registrationId, deploymentId, happened, kind, kind === "success" ? happened : null);
    // A delayed success can identify a replacement even after the previous
    // deployment's removal, without moving that deployment's own event time.
    db.query(`
      WITH latest_success AS (
        SELECT deploymentId FROM railway_deployments
        WHERE registrationId = ? AND successfulAt IS NOT NULL
        ORDER BY successfulAt DESC, deploymentId DESC LIMIT 1
      )
      INSERT INTO railway_checks
      SELECT registrationId, deploymentId, happened, kind, 1, ?, NULL
      FROM railway_deployments
      WHERE registrationId = ? AND (kind != 'removed'
        OR NOT EXISTS (SELECT 1 FROM latest_success)
        OR deploymentId = (SELECT deploymentId FROM latest_success))
      ORDER BY happened DESC, deploymentId DESC LIMIT 1
      ON CONFLICT (registrationId) DO UPDATE SET
        deploymentId = excluded.deploymentId, happened = excluded.happened, kind = excluded.kind,
        pending = 1, nextCheck = excluded.nextCheck, firstFailure = NULL
      WHERE railway_checks.deploymentId != excluded.deploymentId OR railway_checks.happened != excluded.happened
    `).run(registrationId, now, registrationId);
  });

  function receive(app: Registration, payload: unknown, now: number) {
    const type = field(payload, "type");
    const kind = typeof type === "string" ? eventKinds.get(type) : undefined;
    if (!kind) return;
    const timestamp = field(payload, "timestamp");
    const happened = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
    if (!Number.isFinite(happened) || happened < app.registeredAt || happened < now - day || happened > now + 60_000) return;
    const resource = field(payload, "resource");
    const id = (name: string) => field(field(resource, name), "id");
    const deploymentId = id("deployment");
    if (id("project") !== app.projectId || id("environment") !== app.environmentId || id("service") !== app.serviceId ||
        typeof deploymentId !== "string" || !idPattern.test(deploymentId)) return;
    recordEvent.immediate(app.registrationId, deploymentId, happened, kind, now);
  }

  async function drain(now: number, observe: Observe) {
    const list = db.query<Signal, [number, number]>(`
      SELECT apps.*, railway_checks.deploymentId, railway_checks.happened, railway_checks.kind, railway_checks.firstFailure
      FROM railway_checks JOIN apps USING (registrationId)
      WHERE pending = 1 AND nextCheck <= ? AND happened >= ?
      ORDER BY nextCheck, happened LIMIT 20
    `).all(now, now - day);
    let count = 0;
    for (let offset = 0; offset < list.length; offset += probeConcurrency) {
      const checked = await Promise.all(list.slice(offset, offset + probeConcurrency)
        .map(async app => ({ app, healthy: await probe(app.domain).catch(() => false) })));
      const checkedAt = clock();
      const finish = db.transaction(() => {
        const updates: Observation[] = [];
        for (const { app, healthy } of checked) {
          const retry = !healthy && (app.kind === "success" || app.firstFailure === null);
          const changed = db.query(`
            UPDATE railway_checks SET pending = ?, nextCheck = ?, firstFailure = ?
            WHERE registrationId = ? AND deploymentId = ? AND happened = ? AND pending = 1 RETURNING registrationId
          `).get(retry ? 1 : 0, retry ? checkedAt + grace : checkedAt, retry ? checkedAt : null,
            app.registrationId, app.deploymentId, app.happened);
          if (changed && !retry) updates.push({
            slug: app.slug, registrationId: app.registrationId, serviceId: app.serviceId, environmentId: app.environmentId,
            status: healthy ? "up" : "down", reason: healthy ? "" : app.kind,
          });
        }
        observe(updates, checkedAt);
        return updates.length;
      });
      count += finish.immediate();
    }
    db.query("DELETE FROM railway_checks WHERE NOT EXISTS (SELECT 1 FROM apps WHERE apps.registrationId = railway_checks.registrationId)").run();
    db.query(`
      DELETE FROM railway_deployments AS event
      WHERE NOT EXISTS (SELECT 1 FROM apps WHERE apps.registrationId = event.registrationId)
        OR (happened < ? AND NOT EXISTS (
          SELECT 1 FROM railway_checks AS kept
          WHERE kept.registrationId = event.registrationId AND kept.deploymentId = event.deploymentId
        ) AND deploymentId IS NOT (
          SELECT deploymentId FROM railway_deployments AS newer
          WHERE newer.registrationId = event.registrationId AND newer.successfulAt IS NOT NULL
          ORDER BY newer.successfulAt DESC, newer.deploymentId DESC LIMIT 1
        ))
    `).run(now - day);
    return count;
  }

  let running: Promise<number> | undefined;
  function process(now: number, observe: Observe): Promise<number> {
    return running ??= drain(now, observe).finally(() => { running = undefined; });
  }
  return { receive, process };
}
