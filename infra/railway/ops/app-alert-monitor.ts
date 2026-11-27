// Standalone until monitor.ts can call checkDeployedApps after the other
// Railway changes land. Status checks never wake an app with Serverless on.
type App = { slug: string; serviceId: string; environmentId: string; domain: string };
type Deployment = { status: string; deploymentStopped: boolean };
type Instance = { sleepApplication: boolean | null; activeDeployments: Deployment[]; latestDeployment: Deployment | null };
type Observation = { slug: string; status: "up" | "down" | "sleeping" | "unknown"; reason: string };

const railwayUrl = "https://backboard.railway.com/graphql/v2";
const query = `query($serviceId: String!, $environmentId: String!) {
  serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
    sleepApplication
    activeDeployments { status deploymentStopped }
    latestDeployment { status deploymentStopped }
  }
}`;

export async function checkApp(app: App, token: string, request: typeof fetch = fetch): Promise<Observation> {
  const result = (status: Observation["status"], reason = ""): Observation => ({ slug: app.slug, status, reason });
  let instance: Instance | undefined;
  try {
    const response = await request(railwayUrl, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(7000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { serviceId: app.serviceId, environmentId: app.environmentId } }),
    });
    if (!response.ok) return result("unknown");
    const body = await response.json() as { errors?: unknown[]; data?: { serviceInstance?: Instance } };
    if (body.errors?.length) return result("unknown");
    instance = body.data?.serviceInstance;
  } catch {
    return result("unknown");
  }
  if (!instance) return result("unknown");
  const latest = instance.latestDeployment;
  const candidates = [...instance.activeDeployments, ...(latest ? [latest] : [])].filter((d) => !d.deploymentStopped);
  if (!candidates.some((d) => d.status === "SUCCESS")) {
    if (candidates.some((d) => d.status === "SLEEPING")) return result("sleeping");
    if (latest?.deploymentStopped) return result("down", "removed");
    if (latest?.status === "CRASHED") return result("down", "crashed");
    if (latest?.status === "FAILED") return result("down", "failed");
    if (latest?.status === "REMOVED") return result("down", "removed");
    return result("unknown");
  }

  if (instance.sleepApplication !== false) return result("up");
  try {
    const response = await request(`https://${app.domain}/`, {
      method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(5000),
    });
    return response.status >= 500 ? result("down", "http") : result("up");
  } catch {
    return result("down", "unreachable");
  }
}

export async function checkDeployedApps(env = process.env, request: typeof fetch = fetch): Promise<void> {
  const { RUNPORT_ALERT_MONITOR_KEY: key, RAILWAY_MONITOR_TOKEN: token } = env;
  if (!key || !token) throw new Error("App alerts monitor needs RUNPORT_ALERT_MONITOR_KEY and RAILWAY_MONITOR_TOKEN.");
  const url = env.RUNPORT_ALERT_MONITOR_URL ?? "http://mail-gateway.railway.internal:8080/internal/app-alerts";
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const list = await request(url, { headers, redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!list.ok) throw new Error(`Could not read the alerts deployment list (${list.status}).`);
  const apps = await list.json() as App[];
  const observations: Observation[] = [];
  for (let i = 0; i < apps.length; i += 8) {
    const chunk = await Promise.all(apps.slice(i, i + 8).map((app) => checkApp(app, token, request)));
    observations.push(...chunk);
  }
  const response = await request(url, {
    method: "POST", headers, body: JSON.stringify(observations), redirect: "error", signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) throw new Error(`Could not record app alert checks (${response.status}).`);
  const count = (status: Observation["status"]) => observations.filter((result) => result.status === status).length;
  console.log(JSON.stringify({
    check: "app alerts", apps: apps.length, up: count("up"), down: count("down"),
    sleeping: count("sleeping"), unknown: count("unknown"),
  }));
}

if (import.meta.main) await checkDeployedApps();
