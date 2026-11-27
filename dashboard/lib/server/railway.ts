import "server-only";
import { cache } from "react";

// Everything the dashboard knows about hosting comes from Railway's public
// GraphQL API, with a workspace token in RAILWAY_API_TOKEN. Railway has no
// narrower token that can read usage and pause or delete across projects, so
// this file only ever acts on projects that pass isRunportApp().

const API = "https://backboard.railway.com/graphql/v2";

/** Pro plan prices, used to turn usage into dollars. Railway's own bill is the truth. */
const PRICE = {
  cpuPerVcpuMinute: 20 / (30 * 24 * 60),
  memoryPerGbMinute: 10 / (30 * 24 * 60),
  egressPerGb: 0.05,
  diskPerGbMinute: 0.15 / (30 * 24 * 60),
};

export const PLAN_MINIMUM_USD = 20;

/** Runport's own projects. They count towards cost but never get actions. */
const PLATFORM_PROJECTS = new Set(["runport", "runport-dashboard"]);

export class RailwayError extends Error {}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const token = process.env.RAILWAY_API_TOKEN;
  if (!token) throw new RailwayError("RAILWAY_API_TOKEN is not set.");
  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] };
  if (!res.ok || body.errors?.length || !body.data) {
    throw new RailwayError(`Railway: ${body.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`}`);
  }
  return body.data;
}

function workspaceId(): string {
  const id = process.env.RAILWAY_WORKSPACE_ID;
  if (!id) throw new RailwayError("RAILWAY_WORKSPACE_ID is not set.");
  return id;
}

export type DeploymentStatus =
  | "BUILDING" | "CRASHED" | "DEPLOYING" | "FAILED" | "INITIALIZING" | "NEEDS_APPROVAL" | "QUEUED"
  | "REMOVED" | "REMOVING" | "SKIPPED" | "SLEEPING" | "SUCCESS" | "WAITING";

type Deployment = { id: string; status: DeploymentStatus; createdAt: string; deploymentStopped: boolean | null };

export type RailwayService = {
  id: string;
  name: string;
  environmentId: string;
  sleepApplication: boolean;
  latestDeployment: Deployment | null;
  domains: string[];
};

export type RailwayProject = { id: string; name: string; createdAt: string; environmentId: string | null; services: RailwayService[] };

type ProjectsQuery = {
  workspace: {
    projects: {
      edges: {
        node: {
          id: string;
          name: string;
          createdAt: string;
          environments: { edges: { node: { id: string; name: string } }[] };
          services: {
            edges: {
              node: {
                id: string;
                name: string;
                serviceInstances: {
                  edges: {
                    node: {
                      environmentId: string;
                      sleepApplication: boolean | null;
                      latestDeployment: Deployment | null;
                      domains: { customDomains: { domain: string }[]; serviceDomains: { domain: string }[] };
                    };
                  }[];
                };
              };
            }[];
          };
        };
      }[];
    };
  };
};

/** Every project in the workspace, once per request. */
export const listProjects = cache(async (): Promise<RailwayProject[]> => {
  const data = await gql<ProjectsQuery>(
    `query($w: String!) { workspace(workspaceId: $w) { projects { edges { node {
      id name createdAt
      environments { edges { node { id name } } }
      services { edges { node { id name serviceInstances { edges { node {
        environmentId sleepApplication
        latestDeployment { id status createdAt deploymentStopped }
        domains { customDomains { domain } serviceDomains { domain } }
      } } } } } }
    } } } } }`,
    { w: workspaceId() },
  );
  return data.workspace.projects.edges.map(({ node }) => {
    const environmentId = node.environments.edges.find((e) => e.node.name === "production")?.node.id ?? null;
    return {
      id: node.id,
      name: node.name,
      createdAt: node.createdAt,
      environmentId,
      services: node.services.edges.flatMap(({ node: s }) =>
        s.serviceInstances.edges
          .filter((i) => i.node.environmentId === environmentId)
          .map(({ node: i }) => ({
            id: s.id,
            name: s.name,
            environmentId: i.environmentId,
            sleepApplication: !!i.sleepApplication,
            latestDeployment: i.latestDeployment,
            domains: [...i.domains.customDomains.map((d) => d.domain), ...i.domains.serviceDomains.map((d) => d.domain)],
          })),
      ),
    };
  });
});

export async function serviceVariables(projectId: string, environmentId: string, serviceId: string): Promise<Record<string, string>> {
  const data = await gql<{ variables: Record<string, string> }>(
    `query($p: String!, $e: String!, $s: String!) { variables(projectId: $p, environmentId: $e, serviceId: $s) }`,
    { p: projectId, e: environmentId, s: serviceId },
  );
  return data.variables;
}

export type RunportApp = {
  slug: string;
  project: RailwayProject;
  web: RailwayService;
  /** The app's public address, custom domain first. */
  url: string | null;
  /** Server-only: the app's own Appwrite key, used for the backup before delete. */
  appwriteKey: string;
  analyticsSiteId: string | null;
};

const runportEndpoint = () => (process.env.APPWRITE_ENDPOINT ?? "").replace(/\/+$/, "");

/**
 * A Runport app is a project named "<slug>-app" with a "web" service whose
 * settings point at this Runport's Appwrite with project id <slug>. That is
 * exactly what mcp/src/deploy-app.ts creates. Anything else is left alone.
 */
async function toRunportApp(project: RailwayProject): Promise<RunportApp | null> {
  if (PLATFORM_PROJECTS.has(project.name) || !project.name.endsWith("-app") || !project.environmentId) return null;
  const slug = project.name.slice(0, -"-app".length);
  if (!/^[a-z0-9][a-z0-9-]{0,35}$/.test(slug)) return null;
  const web = project.services.find((s) => s.name === "web");
  if (!web) return null;
  const vars = await serviceVariables(project.id, project.environmentId, web.id);
  if ((vars.APPWRITE_ENDPOINT ?? "").replace(/\/+$/, "") !== runportEndpoint() || vars.APPWRITE_PROJECT_ID !== slug || !vars.APPWRITE_API_KEY) {
    return null;
  }
  const custom = web.domains.find((d) => !d.endsWith(".up.railway.app"));
  const host = custom ?? web.domains[0];
  return {
    slug,
    project,
    web,
    url: host ? `https://${host}` : (vars.APP_URL ?? null),
    appwriteKey: vars.APPWRITE_API_KEY,
    analyticsSiteId: vars.ANALYTICS_SITE_ID || null,
  };
}

export const listApps = cache(async (): Promise<RunportApp[]> => {
  const projects = await listProjects();
  const apps = await Promise.all(projects.map(toRunportApp));
  return apps.filter((a): a is RunportApp => !!a).sort((a, b) => a.slug.localeCompare(b.slug));
});

/** The one app with this slug, or null. Actions always go through this check. */
export async function findApp(slug: string): Promise<RunportApp | null> {
  return (await listApps()).find((a) => a.slug === slug) ?? null;
}

export type AppStatus = "live" | "sleeping" | "down" | "deploying" | "paused" | "unknown";

export function appStatus(web: RailwayService): AppStatus {
  const d = web.latestDeployment;
  if (!d) return "unknown";
  switch (d.status) {
    case "SLEEPING":
      return "sleeping";
    case "BUILDING":
    case "DEPLOYING":
    case "INITIALIZING":
    case "QUEUED":
    case "WAITING":
      return "deploying";
    case "CRASHED":
    case "FAILED":
      return "down";
    case "REMOVED":
    case "REMOVING":
      return "paused";
    case "SUCCESS":
      return d.deploymentStopped ? "paused" : "live";
    default:
      return "unknown";
  }
}

// --- Cost ---------------------------------------------------------------

export type BillingPeriod = { start: string; end: string; accountTotal: number };

export const billingPeriod = cache(async (): Promise<BillingPeriod> => {
  const data = await gql<{ workspace: { customer: { currentUsage: number; billingPeriod: { start: string; end: string } } } }>(
    `query($w: String!) { workspace(workspaceId: $w) { customer { currentUsage billingPeriod { start end } } } }`,
    { w: workspaceId() },
  );
  const c = data.workspace.customer;
  return { start: c.billingPeriod.start, end: c.billingPeriod.end, accountTotal: c.currentUsage };
});

/** Approximate dollars per project for the current billing period. */
export const costByProject = cache(async (): Promise<Map<string, number>> => {
  const period = await billingPeriod();
  const data = await gql<{ usage: { measurement: string; value: number; tags: { projectId: string | null } }[] }>(
    `query($w: String!, $s: DateTime!, $e: DateTime!) {
      usage(workspaceId: $w, startDate: $s, endDate: $e, groupBy: [PROJECT_ID], measurements: [CPU_USAGE, MEMORY_USAGE_GB, NETWORK_TX_GB, DISK_USAGE_GB]) {
        measurement value tags { projectId }
      }
    }`,
    { w: workspaceId(), s: period.start, e: new Date().toISOString() },
  );
  const cost = new Map<string, number>();
  for (const row of data.usage) {
    if (!row.tags.projectId) continue;
    const rate =
      row.measurement === "CPU_USAGE" ? PRICE.cpuPerVcpuMinute
      : row.measurement === "MEMORY_USAGE_GB" ? PRICE.memoryPerGbMinute
      : row.measurement === "NETWORK_TX_GB" ? PRICE.egressPerGb
      : row.measurement === "DISK_USAGE_GB" ? PRICE.diskPerGbMinute
      : 0;
    cost.set(row.tags.projectId, (cost.get(row.tags.projectId) ?? 0) + row.value * rate);
  }
  return cost;
});

/** Runport's share: the platform project, the dashboard and every app. */
export async function runportCost(): Promise<{ total: number; period: BillingPeriod }> {
  const [projects, apps, cost, period] = await Promise.all([listProjects(), listApps(), costByProject(), billingPeriod()]);
  const ids = new Set([...projects.filter((p) => PLATFORM_PROJECTS.has(p.name)).map((p) => p.id), ...apps.map((a) => a.project.id)]);
  let total = 0;
  for (const id of ids) total += cost.get(id) ?? 0;
  return { total, period };
}

// --- Platform -------------------------------------------------------------

export function platformService(name: string): Promise<RailwayService | null> {
  return listProjects().then((projects) => projects.find((p) => p.name === "runport")?.services.find((s) => s.name === name) ?? null);
}

export type BackupResult = { ok: boolean; at: string; detail: string | null };

type LogLine = { timestamp: string; attributes: { key: string; value: string }[] };

/**
 * The newest result the nightly backup job logged ("backup ok" or "backup
 * failed"), read from the job's logs. Each night is a run of the current
 * deployment, so a redeploy does not count as a backup.
 */
export async function lastBackup(): Promise<BackupResult | null> {
  const projects = await listProjects();
  const runport = projects.find((p) => p.name === "runport");
  const backup = runport?.services.find((s) => s.name === "backup");
  if (!runport || !backup) throw new RailwayError("The backup job was not found on Railway.");
  const data = await gql<{ deployments: { edges: { node: { id: string } }[] } }>(
    `query($p: String!, $e: String!, $s: String!) {
      deployments(first: 4, input: { projectId: $p, environmentId: $e, serviceId: $s }) { edges { node { id } } }
    }`,
    { p: runport.id, e: backup.environmentId, s: backup.id },
  );
  for (const { node } of data.deployments.edges) {
    const logs = await gql<{ deploymentLogs: LogLine[] }>(
      `query($d: String!) { deploymentLogs(deploymentId: $d, limit: 500) { timestamp attributes { key value } } }`,
      { d: node.id },
    );
    const results = logs.deploymentLogs
      .map((line) => {
        const attr = (k: string) => line.attributes.find((a) => a.key === k)?.value?.replace(/^"|"$/g, "") ?? null;
        return { at: line.timestamp, result: attr("result"), reason: attr("reason") };
      })
      .filter((l) => l.result === "backup ok" || l.result === "backup failed");
    const newest = results.at(-1);
    if (newest) return { ok: newest.result === "backup ok", at: newest.at, detail: newest.reason };
  }
  return null;
}

// --- Actions -------------------------------------------------------------

/** Stops the app's running deployment. Visitors get Railway's "not found" until resumed. */
export async function pauseApp(app: RunportApp): Promise<void> {
  const d = app.web.latestDeployment;
  if (!d) throw new RailwayError("This app has no deployment to pause.");
  await gql(`mutation($id: String!) { deploymentStop(id: $id) }`, { id: d.id });
}

/** Starts the last deployment again, from the image it already has. */
export async function resumeApp(app: RunportApp): Promise<void> {
  const d = app.web.latestDeployment;
  if (!d) throw new RailwayError("This app has no deployment to resume.");
  await gql(`mutation($id: String!) { deploymentRedeploy(id: $id, usePreviousImageTag: true) { id } }`, { id: d.id });
}

/** Deletes the whole Railway project: the hosting and its addresses. */
export async function deleteProject(app: RunportApp): Promise<void> {
  if (PLATFORM_PROJECTS.has(app.project.name)) throw new RailwayError("Refusing to delete a Runport platform project.");
  await gql(`mutation($id: String!) { projectDelete(id: $id) }`, { id: app.project.id });
}
