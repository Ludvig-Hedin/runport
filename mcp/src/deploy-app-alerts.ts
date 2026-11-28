import { createHmac } from "node:crypto";
import { config } from "./config";
import { readSecret } from "./keychain";
import type { AppRecord } from "./registry";

export type RailwayProject = {
  id: string;
  environments: { edges: { node: { id: string; name: string } }[] };
  services: { edges: { node: { id: string; name: string } }[] };
};

export function webService(project: RailwayProject) {
  const environmentId = project.environments.edges.find(({ node }) => node.name === "production")?.node.id;
  const serviceId = project.services.edges.find(({ node }) => node.name === "web")?.node.id;
  if (!project.id || !environmentId || !serviceId) throw new Error("Could not identify Railway's production web service.");
  return { projectId: project.id, environmentId, serviceId };
}

async function setup(origin: string, keychainService: string) {
  const target = new URL(origin);
  // Never send the registration credential to an implicit alternate origin.
  // Local development can explicitly override it with its own gateway key.
  if (target.origin !== "https://admin.runport.app" && keychainService === "runport-prod") {
    throw new Error("An alternate app-alert gateway requires a separate keychain service.");
  }
  const master = await readSecret("mail-master-key", keychainService);
  const key = (purpose: string) => createHmac("sha256", master).update(`runport-app-alerts:${purpose}`).digest("hex");
  async function update(slug: string, method: "POST" | "DELETE", data: object) {
    const response = await fetch(new URL(`/_runport/alerts/register/${slug}`, target), {
      method, headers: { Authorization: `Bearer ${key("register")}`, "Content-Type": "application/json" },
      body: JSON.stringify(data), redirect: "error", signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`App alert registry update failed (${response.status}).`);
  }
  return { target, key, update };
}

export async function registerAppAlerts(slug: string, project: RailwayProject, domain: string, accountMaintenance: boolean) {
  const keychainService = config.keychainService;
  const { target, key, update } = await setup(process.env.PLATFORM_ALERT_ORIGIN ?? "https://admin.runport.app", keychainService);
  const service = webService(project);
  await update(slug, "POST", { slug, ...service, domain, accountMaintenance });
  return {
    registration: { origin: target.origin, keychainService, environmentId: service.environmentId, serviceId: service.serviceId },
    ...(accountMaintenance ? {
      RUNPORT_ACCOUNT_MAINTENANCE_KEY: createHmac("sha256", key("monitor"))
        .update(`runport-account-maintenance:${slug}:${service.serviceId}:${service.environmentId}:${domain}`).digest("hex"),
    } : {}),
    RUNPORT_ERROR_URL: new URL(`/_runport/alerts/report/${slug}`, target).href,
    RUNPORT_ERROR_TOKEN: key(`report:${slug}:${service.serviceId}:${service.environmentId}`),
  };
}

export async function retireAppAlerts(slug: string, alerts: NonNullable<AppRecord["alerts"]>) {
  const { origin, keychainService, environmentId, serviceId } = alerts;
  const { update } = await setup(origin, keychainService);
  await update(slug, "DELETE", { environmentId, serviceId });
}
