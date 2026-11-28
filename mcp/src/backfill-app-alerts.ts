import { writeFile } from "node:fs/promises";
import { config, registryFile } from "./config";
import { registerAppAlerts, webService, type RailwayProject } from "./deploy-app-alerts";
import { railwayApi } from "./railway-api";
import { loadRegistry, upsertApp } from "./registry";

const targets = ["todo", "auth-preview"];
const slugs = [...new Set(process.argv.slice(2))];
if (!slugs.length || slugs.some(slug => !targets.includes(slug))) {
  throw new Error("Usage: bun mcp/src/backfill-app-alerts.ts todo auth-preview");
}

const store = registryFile();
const before = await loadRegistry(store);
const prepared = await Promise.all(slugs.map(async slug => {
  const app = before.apps.find(record => record.slug === slug);
  if (!app || app.setupPending) throw new Error(`No deployed app found for ${slug}.`);
  const status = Bun.spawn(["railway", "status", "--json"], { cwd: app.folder, stdout: "pipe", stderr: "ignore" });
  const [output, exit] = await Promise.all([new Response(status.stdout).text(), status.exited]);
  if (exit !== 0) throw new Error(`No Railway project linked for ${slug}.`);
  const project = JSON.parse(output) as RailwayProject & { name: string };
  if (project.name !== `${slug}-app`) throw new Error(`Unexpected Railway project linked for ${slug}.`);
  const { serviceId, environmentId } = webService(project);
  const { serviceInstance } = await railwayApi<{ serviceInstance: { domains: { serviceDomains: { domain: string }[] } } }>(
    `query($serviceId: String!, $environmentId: String!) {
      serviceInstance(serviceId: $serviceId, environmentId: $environmentId) { domains { serviceDomains { domain } } }
    }`, { serviceId, environmentId },
  );
  const [domain, ...others] = serviceInstance.domains.serviceDomains.map(item => item.domain)
    .filter(value => /^[a-z0-9][a-z0-9-]{0,62}\.up\.railway\.app$/.test(value));
  if (!domain || others.length) throw new Error(`Could not identify the Railway health URL for ${slug}.`);
  return { app, project, domain };
}));

const backup = `${store}.alerts-backup-${crypto.randomUUID()}`;
await writeFile(backup, await Bun.file(store).text(), { flag: "wx", mode: 0o600 });
for (const { app, project, domain } of prepared) {
  const { registration } = await registerAppAlerts(app.slug, project, domain);
  const current = (await loadRegistry(store)).apps.find(record => record.slug === app.slug);
  if (!current || current.folder !== app.folder) throw new Error(`App registry changed during backfill for ${app.slug}.`);
  await upsertApp({ ...current, alerts: { ...current.alerts, ...registration } });
  console.log(`Registered Railway app alerts for ${app.slug}.`);
}
const after = await loadRegistry(store);
if (after.apps.length !== before.apps.length || !before.apps.every(app => after.apps.some(current => current.slug === app.slug))) {
  throw new Error("App registry contents changed during the alerts backfill. The backup was kept.");
}
console.log(`Verified ${after.apps.length} registry entries under ${config.appsDir}.`);
