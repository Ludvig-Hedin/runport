import { createHmac } from "node:crypto";

type App = { slug: string; serviceId: string; environmentId: string; domain: string };
type Fetch = typeof fetch;

async function probe(app: App, key: string, request: Fetch): Promise<boolean> {
  if (!/^[a-z0-9][a-z0-9-]{0,62}\.up\.railway\.app$/.test(app.domain)) return false;
  // Only the key for this deployment and host leaves the monitor. Never
  // send the inventory credential or follow a redirect with a bearer key.
  const token = createHmac("sha256", key)
    .update(`runport-account-maintenance:${app.slug}:${app.serviceId}:${app.environmentId}:${app.domain}`).digest("hex");
  try {
    const response = await request(`https://${app.domain}/api/runport/account-maintenance`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    // Older app deployments do not have this route yet.
    return response.ok || response.status === 404 || response.status === 429;
  } catch {
    return false;
  }
}

export async function maintainAccounts(env = process.env, request = fetch): Promise<void> {
  const key = env.RUNPORT_ALERT_MONITOR_KEY;
  if (!key) throw new Error("Account maintenance needs RUNPORT_ALERT_MONITOR_KEY.");
  const list = new URL(env.RUNPORT_ALERT_MONITOR_URL ?? "http://mail-gateway.railway.internal:8080/internal/app-alerts");
  let after = "";
  let failed = 0;
  for (;;) {
    list.searchParams.set("accountMaintenanceAfter", after);
    const response = await request(list, {
      headers: { Authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Could not list apps for account maintenance (${response.status}).`);
    const { apps, next } = await response.json() as { apps: App[]; next?: string | null };
    // During a coordinated rollout, the old gateway lacks this inventory.
    if (next === undefined) return;
    for (let start = 0; start < apps.length; start += 10) {
      const results = await Promise.all(apps.slice(start, start + 10).map((app) => probe(app, key, request)));
      failed += results.filter((ok) => !ok).length;
    }
    if (next === null) break;
    if (next <= after) throw new Error("Account maintenance inventory returned a repeated cursor.");
    after = next;
  }
  if (failed) throw new Error(`${failed} app account maintenance probes failed. The next run will retry.`);
}
