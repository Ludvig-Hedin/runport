import { createHmac } from "node:crypto";
import { config } from "./config";
import { readSecret } from "./keychain";

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

export async function registerAppAlerts(slug: string, project: RailwayProject, domain: string) {
  const origin = process.env.PLATFORM_ALERT_ORIGIN ?? "https://admin.runport.app";
  const target = new URL(origin);
  // Never send the registration credential to an implicit alternate origin.
  // Local development can explicitly override it with its own gateway key.
  if (target.origin !== "https://admin.runport.app" && config.keychainService === "runport-prod") {
    throw new Error("An alternate app-alert gateway requires a separate keychain service.");
  }
  const master = await readSecret("mail-master-key");
  const key = (purpose: string) => createHmac("sha256", master).update(`runport-app-alerts:${purpose}`).digest("hex");
  const endpoint = new URL(`/_runport/alerts/register/${slug}`, target);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${key("register")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ slug, ...webService(project), domain }),
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`App alert registration failed (${response.status}).`);
  return {
    RUNPORT_ERROR_URL: new URL(`/_runport/alerts/report/${slug}`, target).href,
    RUNPORT_ERROR_TOKEN: key(`report:${slug}`),
  };
}
