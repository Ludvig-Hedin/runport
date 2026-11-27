type App = {
  slug: string; registrationId: string; projectId: string; serviceId: string;
  environmentId: string; domain: string; incident: number | null;
};
type Deployment = { status: string; deploymentStopped: boolean; instances: Array<{ status: string }> };
type Instance = {
  serviceId: string; deletedAt: string | null; sleepApplication: boolean | null;
  activeDeployments: Deployment[]; latestDeployment: Deployment | null;
};
type Observation = Pick<App, "slug" | "registrationId" | "serviceId" | "environmentId"> & {
  status: "up" | "down" | "sleeping" | "unknown" | "retired"; reason: string;
};
type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

const railwayUrl = "https://backboard.railway.com/graphql/v2";
const deploymentFields = "status deploymentStopped instances { status }";
const query = `query($projectId: String!, $environmentId: String!, $after: String) {
  environment(id: $environmentId, projectId: $projectId) {
    deletedAt
    serviceInstances(first: 50, after: $after) {
      edges { node {
        serviceId
        deletedAt
        sleepApplication
        activeDeployments { ${deploymentFields} }
        latestDeployment { ${deploymentFields} }
      } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

type EnvironmentPage = {
  deletedAt: string | null;
  serviceInstances: { edges: Array<{ node: Instance }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
};

class RateLimited extends Error {
  constructor(readonly waitMs: number) { super("Railway rate limit reached"); }
}

function retryAfter(value: string | null): number {
  const delay = value && /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value ?? "") - Date.now();
  return delay > 0 ? Math.min(delay, 30 * 24 * 60 * 60_000) : 5 * 60_000;
}

function timeout(ms: number, deadline?: AbortSignal): AbortSignal {
  const limit = AbortSignal.timeout(ms);
  return deadline ? AbortSignal.any([deadline, limit]) : limit;
}

const inactiveStatuses = new Set(["CRASHED", "EXITED", "REMOVED", "STOPPED", "SKIPPED"]);

export async function checkApp(
  app: App,
  token: string,
  request: Fetch = fetch,
  pause: (ms: number) => Promise<unknown> = Bun.sleep,
  deadline?: AbortSignal,
): Promise<Observation> {
  const { slug, registrationId, serviceId, environmentId } = app;
  const result = (status: Observation["status"], reason = ""): Observation =>
    ({ slug, registrationId, serviceId, environmentId, status, reason });
  let instance: Instance | undefined;
  let after: string | null = null;
  try {
    for (let page = 0; page < 4 && !deadline?.aborted; page++) {
      const response = await request(railwayUrl, {
        method: "POST",
        redirect: "error",
        signal: timeout(6000, deadline),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { projectId: app.projectId, environmentId, after } }),
      });
      if (response.status === 429) throw new RateLimited(retryAfter(response.headers.get("Retry-After")));
      if (!response.ok) return result("unknown");
      const body = await response.json() as {
        errors?: Array<{ extensions?: { code?: string } }>;
        data?: { environment?: EnvironmentPage };
      };
      if (body.errors?.some((error) => /^RATE_LIMIT(?:ED|_EXCEEDED)?$/.test(error.extensions?.code ?? ""))) {
        throw new RateLimited(retryAfter(response.headers.get("Retry-After")));
      }
      const environment = body.data?.environment;
      if (body.errors?.length || !environment) return result("unknown");
      if (environment.deletedAt) return result("retired");
      const { edges, pageInfo } = environment.serviceInstances;
      instance = edges.find(({ node }) => node.serviceId === serviceId)?.node;
      if (instance) {
        if (instance.deletedAt) return result("retired");
        break;
      }
      // The direct non-null serviceInstance query can return the same
      // authorization error for missing and inaccessible services. Only a
      // successful, complete environment listing proves absence.
      if (pageInfo.hasNextPage === false) return result("retired");
      if (!pageInfo.endCursor || pageInfo.endCursor === after) return result("unknown");
      after = pageInfo.endCursor;
    }
  } catch (error) {
    if (error instanceof RateLimited) throw error;
    return result("unknown");
  }
  if (!instance || deadline?.aborted) return result("unknown");
  const latest = instance.latestDeployment;
  const candidates = [...instance.activeDeployments, ...(latest ? [latest] : [])].filter((d) => !d.deploymentStopped);
  const running = candidates.filter((deployment) => deployment.status === "SUCCESS");
  const sleeping = running.length === 0 && candidates.some((deployment) => deployment.status === "SLEEPING");
  if (sleeping && app.incident == null) return result("sleeping");
  if (!running.length && !sleeping) {
    if (latest?.deploymentStopped || latest?.status === "REMOVED") return result("down", "removed");
    if (latest?.status === "CRASHED") return result("down", "crashed");
    if (latest?.status === "FAILED") return result("down", "failed");
    return result("unknown");
  }

  // SUCCESS can outlive the process. Recovery requires a response from
  // the public app. Only wake a confirmed sleeper with an open incident.
  let failure = "unreachable";
  const attempts = instance.sleepApplication || sleeping ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await pause(5000);
    if (deadline?.aborted) return result("unknown");
    try {
      const response = await request(`https://${app.domain}/`, {
        method: "HEAD", redirect: "manual", signal: timeout(6000, deadline),
      });
      if ((response.status >= 200 && response.status < 400) || response.status === 401 || response.status === 403) return result("up");
      failure = "http";
    } catch {
      failure = "unreachable";
    }
  }
  if (deadline?.aborted) return result("unknown");
  if (sleeping) return result("sleeping");
  const instances = running.flatMap((deployment) => deployment.instances);
  const exited = instances.length > 0 && instances.every((item) => inactiveStatuses.has(item.status));
  return result("down", exited ? "exited" : failure);
}

export async function checkDeployedApps(env = process.env, request: Fetch = fetch): Promise<void> {
  const { RUNPORT_ALERT_MONITOR_KEY: key, RAILWAY_MONITOR_TOKEN: token } = env;
  if (!key || !token) throw new Error("App alerts monitor needs RUNPORT_ALERT_MONITOR_KEY and RAILWAY_MONITOR_TOKEN.");
  const url = env.RUNPORT_ALERT_MONITOR_URL ?? "http://mail-gateway.railway.internal:8080/internal/app-alerts";
  const headers = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const list = await request(url, { headers, redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!list.ok) throw new Error(`Could not read the alerts deployment list (${list.status}).`);
  const { apps } = await list.json() as { apps: App[] };
  const observations: Observation[] = [];
  let retryAfterMs = 0;
  const deadline = AbortSignal.timeout(120_000);
  for (const app of apps.slice(0, 20)) {
    if (deadline.aborted) break;
    try {
      const observation = await checkApp(app, token, request, undefined, deadline);
      if (!deadline.aborted) observations.push(observation);
    } catch (error) {
      if (!(error instanceof RateLimited)) throw error;
      retryAfterMs = error.waitMs;
      break;
    }
  }
  const response = await request(url, {
    method: "POST", headers, body: JSON.stringify({ observations, retryAfterMs }), redirect: "error", signal: AbortSignal.timeout(65_000),
  });
  if (!response.ok) throw new Error(`Could not record app alert checks (${response.status}).`);
  const count = (status: Observation["status"]) => observations.filter((result) => result.status === status).length;
  console.log(JSON.stringify({
    check: "app alerts", apps: observations.length, up: count("up"), down: count("down"),
    sleeping: count("sleeping"), unknown: count("unknown"), retired: count("retired"), retryAfterMs,
  }));
  const failed = response.headers.get("X-Runport-Alert-Delivery-Failures");
  if (failed && /^[1-9]\d*$/.test(failed)) {
    throw new Error(`Owner alert delivery failed for ${failed} retained alert(s). See the mail gateway logs.`);
  }
}

if (import.meta.main) await checkDeployedApps();
