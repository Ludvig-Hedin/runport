import "server-only";
import { cache } from "react";
import { type Deployment, deployments, type HostingStatus, hostingStatus, type Pins } from "@/lib/ops/hosting";
import { checkPins, duplicateSlugs, type PinProject } from "@/lib/ops/pins";
import { loadPins, type AppPins } from "./registry";

// Hosting facts from Railway's GraphQL API, with a workspace token in
// RAILWAY_API_TOKEN. Railway has no narrower token that reads usage across
// projects, so the dashboard only ever changes projects whose ids are pinned
// in its app list (registry.ts) and match what Railway reports.

const API = "https://backboard.railway.com/graphql/v2";

/** Pro plan prices, used to turn usage into dollars. Railway's own bill is the truth. */
const PRICE = {
  cpuPerVcpuMinute: 20 / (30 * 24 * 60),
  memoryPerGbMinute: 10 / (30 * 24 * 60),
  egressPerGb: 0.05,
  diskPerGbMinute: 0.15 / (30 * 24 * 60),
};

export const PLAN_MINIMUM_USD = 20;

/** Runport's own projects: counted in the cost, never acted on. */
const PLATFORM_PROJECTS = new Set(["runport", "runport-dashboard"]);
export type { PinProject };

export class RailwayError extends Error {}

/** Railway's error text can echo inputs, so only a short reason leaves this function. */
export async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const token = process.env.RAILWAY_API_TOKEN;
  if (!token) throw new RailwayError("Railway is not connected yet.");
  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => {
    throw new RailwayError("Railway did not answer.");
  });
  const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] };
  if (!res.ok || body.errors?.length || !body.data) {
    const denied = body.errors?.some((e) => /not authorized/i.test(e.message)) || res.status === 401 || res.status === 403;
    throw new RailwayError(denied ? "Railway refused the dashboard's access." : `Railway answered with an error (${res.status}).`);
  }
  return body.data;
}

function workspaceId(): string {
  const id = process.env.RAILWAY_WORKSPACE_ID;
  if (!id) throw new RailwayError("RAILWAY_WORKSPACE_ID is not set.");
  return id;
}

type ServiceInfo = { id: string; name: string; domains: string[] };
export type RailwayProject = {
  id: string;
  name: string;
  environments: { id: string; name: string }[];
  services: ServiceInfo[];
  volumes: number;
  /** Instances per environment, by service id, for the production check. */
  instances: { serviceId: string; environmentId: string; domains: string[] }[];
};

type ProjectsQuery = {
  workspace: {
    projects: {
      edges: {
        node: {
          id: string;
          name: string;
          environments: { edges: { node: { id: string; name: string } }[] };
          volumes: { edges: unknown[] };
          services: {
            edges: {
              node: {
                id: string;
                name: string;
                serviceInstances: {
                  edges: { node: { environmentId: string; domains: { customDomains: { domain: string }[]; serviceDomains: { domain: string }[] } } }[];
                };
              };
            }[];
          };
        };
      }[];
    };
  };
};

/** Every project in the workspace, once per request. Read only. */
export const listProjects = cache(async (): Promise<RailwayProject[]> => {
  const data = await gql<ProjectsQuery>(
    `query($w: String!) { workspace(workspaceId: $w) { projects { edges { node {
      id name
      environments { edges { node { id name } } }
      volumes { edges { node { id } } }
      services { edges { node { id name serviceInstances { edges { node {
        environmentId
        domains { customDomains { domain } serviceDomains { domain } }
      } } } } } }
    } } } } }`,
    { w: workspaceId() },
  );
  return data.workspace.projects.edges.map(({ node }) => {
    const instances = node.services.edges.flatMap(({ node: s }) =>
      s.serviceInstances.edges.map(({ node: i }) => ({
        serviceId: s.id,
        environmentId: i.environmentId,
        domains: [...i.domains.customDomains.map((d) => d.domain), ...i.domains.serviceDomains.map((d) => d.domain)],
      })),
    );
    return {
      id: node.id,
      name: node.name,
      environments: node.environments.edges.map((e) => e.node),
      volumes: node.volumes.edges.length,
      services: node.services.edges.map(({ node: s }) => ({ id: s.id, name: s.name, domains: instances.filter((i) => i.serviceId === s.id).flatMap((i) => i.domains) })),
      instances,
    };
  });
});

export type AppStatus = HostingStatus | "unverified";

export type RunportApp = {
  pins: AppPins;
  /** Set when the pinned ids do not match Railway. Such an app gets no actions. */
  problem: string | null;
  url: string | null;
  status: AppStatus;
  lastDeployAt: string | null;
  /** Anything a delete would also destroy that the backup cannot bring back. */
  extras: string[];
};

export const toPins = (a: AppPins): Pins => ({ projectId: a.railwayProjectId, environmentId: a.environmentId, serviceId: a.serviceId });

export const listApps = cache(async (): Promise<RunportApp[]> => {
  const [pinned, projects] = await Promise.all([loadPins(), listProjects()]);
  const duplicates = duplicateSlugs(pinned);
  return Promise.all(
    pinned.map(async (pins): Promise<RunportApp> => {
      const { problem, project, extras } = checkPins(pins, projects, workspaceId(), duplicates);
      if (problem || !project) return { pins, problem, url: null, status: "unverified", lastDeployAt: null, extras };
      const domains = project.instances.find((i) => i.serviceId === pins.serviceId && i.environmentId === pins.environmentId)?.domains ?? [];
      const host = domains.find((d) => !d.endsWith(".up.railway.app")) ?? domains[0];
      const list: Deployment[] = await deployments(gql, toPins(pins));
      return { pins, problem: null, url: host ? `https://${host}` : null, status: hostingStatus(list), lastDeployAt: list[0]?.createdAt ?? null, extras };
    }),
  );
});

/** The verified app with this slug, or null. Every action goes through this. */
export async function findApp(slug: string): Promise<RunportApp | null> {
  const app = (await listApps()).find((a) => a.pins.slug === slug);
  return app && !app.problem ? app : null;
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

/** Runport's share: the platform project, the dashboard and every pinned app. */
export async function runportCost(): Promise<{ total: number; period: BillingPeriod }> {
  const [projects, pinned, cost, period] = await Promise.all([listProjects(), loadPins(), costByProject(), billingPeriod()]);
  const ids = new Set([...projects.filter((p) => PLATFORM_PROJECTS.has(p.name)).map((p) => p.id), ...pinned.map((a) => a.railwayProjectId)]);
  let total = 0;
  for (const id of ids) total += cost.get(id) ?? 0;
  return { total, period };
}

// --- Platform -------------------------------------------------------------

async function runportService(name: string): Promise<{ project: RailwayProject; service: ServiceInfo; environmentId: string } | null> {
  const project = (await listProjects()).find((p) => p.name === "runport");
  const service = project?.services.find((s) => s.name === name);
  const environmentId = project?.environments.find((e) => e.name === "production")?.id;
  return project && service && environmentId ? { project, service, environmentId } : null;
}

/** Whether a Runport platform service is running. */
export async function platformServiceUp(name: string): Promise<boolean | null> {
  const found = await runportService(name);
  if (!found) return null;
  const list = await deployments(gql, { projectId: found.project.id, environmentId: found.environmentId, serviceId: found.service.id });
  return list.some((d) => d.status === "SUCCESS" && !d.deploymentStopped);
}

export type BackupStatus = { ok: boolean; at: string };

type LogLine = { timestamp: string; attributes: { key: string; value: string }[] };

/**
 * The newest result the nightly backup job logged ("backup ok" or "backup
 * failed"), read from the job's logs. A redeploy of the job is not a backup.
 */
export async function lastBackup(): Promise<BackupStatus | null> {
  const found = await runportService("backup");
  if (!found) throw new RailwayError("The backup job was not found on Railway.");
  const list = await deployments(gql, { projectId: found.project.id, environmentId: found.environmentId, serviceId: found.service.id });
  for (const d of list.slice(0, 4)) {
    const logs = await gql<{ deploymentLogs: LogLine[] }>(
      `query($d: String!) { deploymentLogs(deploymentId: $d, limit: 500) { timestamp attributes { key value } } }`,
      { d: d.id },
    );
    const results = logs.deploymentLogs
      .map((line) => ({ at: line.timestamp, result: line.attributes.find((a) => a.key === "result")?.value?.replace(/^"|"$/g, "") }))
      .filter((l) => l.result === "backup ok" || l.result === "backup failed");
    const newest = results.at(-1);
    if (newest) return { ok: newest.result === "backup ok", at: newest.at };
  }
  return null;
}

// --- Delete --------------------------------------------------------------

/** Deletes the pinned Railway project and confirms it is gone. */
export async function deleteRailwayProject(app: RunportApp): Promise<void> {
  if (app.problem) throw new RailwayError("Refusing to delete a project that does not match its pinned ids.");
  const id = app.pins.railwayProjectId;
  // Asks the workspace for its project list, fresh: an access error throws
  // instead of looking like "already gone".
  const exists = async () =>
    gql<{ workspace: { projects: { edges: { node: { id: string } }[] } } }>(
      `query($w: String!) { workspace(workspaceId: $w) { projects { edges { node { id } } } } }`,
      { w: workspaceId() },
    ).then((d) => d.workspace.projects.edges.some((e) => e.node.id === id));
  if (!(await exists())) return;
  await gql(`mutation($id: String!) { projectDelete(id: $id) }`, { id });
  for (let i = 0; i < 10; i++) {
    if (!(await exists())) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new RailwayError("Railway did not confirm the hosting was removed.");
}
