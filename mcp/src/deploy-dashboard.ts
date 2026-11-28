// Puts Runport's own dashboard (the repo's dashboard/ folder) online at
// dash.runport.app, in its own Railway project, so it never touches the
// runport project's config. Safe to rerun.
// Run: PLATFORM_KEYCHAIN_SERVICE=runport-prod PLATFORM_APPWRITE_ENDPOINT=https://admin.runport.app/v1 bun src/deploy-dashboard.ts [--keys=all|none|slug,slug]
//
// Every target is pinned in dashboard/runport.deploy.json and checked against
// Railway and Appwrite before anything changes. Secrets come from Keychain
// runport-prod and go to Railway through its API, never through arguments or
// logs; errors say only which step failed and the status code.
import { resolve } from "node:path";
import { AppwriteAdmin } from "./appwrite-admin";
import { config } from "./config";
import { readSecret, writeSecret } from "./keychain";
import { loginSmtp } from "./login-smtp";
import { railwayApi } from "./railway-api";
import { type KeyPair, syncDashboard } from "./sync-dashboard";

const folder = resolve(import.meta.dir, "..", "..", "dashboard");
type DeployPins = { workspaceId: string; projectId: string; projectName: string; environmentId: string; serviceId: string; appwriteProjectId: string; appwriteProjectName: string; domain: string; port: string };
const pins = (await Bun.file(resolve(folder, "runport.deploy.json")).json()) as DeployPins;
for (const k of ["workspaceId", "projectId", "projectName", "environmentId", "serviceId", "appwriteProjectId", "appwriteProjectName", "domain", "port"] as const) {
  if (!pins[k]) throw new Error(`dashboard/runport.deploy.json is missing ${k}. Nothing was changed.`);
}
const keysArg = process.argv.find((a) => a.startsWith("--keys="))?.slice("--keys=".length) ?? "all";
const mintKeysFor = keysArg === "all" ? ("all" as const) : new Set(keysArg === "none" ? [] : keysArg.split(","));

async function keychain(account: string): Promise<string | null> {
  return readSecret(account, "runport-prod").catch(() => null);
}

// 0. Check every pinned Railway id before changing anything.
type Check = { project: { id: string; name: string; workspaceId: string; environments: { edges: { node: { id: string; name: string } }[] }; services: { edges: { node: { id: string; name: string } }[] } } | null };
const check = await railwayApi<Check>(
  "query($p: String!) { project(id: $p) { id name workspaceId environments { edges { node { id name } } } services { edges { node { id name } } } } }",
  { p: pins.projectId },
);
const p = check.project;
if (!p || p.name !== pins.projectName || p.workspaceId !== pins.workspaceId) throw new Error("The pinned Railway project does not match. Nothing was changed.");
if (!p.environments.edges.some((e) => e.node.id === pins.environmentId && e.node.name === "production")) throw new Error("The pinned environment does not match. Nothing was changed.");
if (!p.services.edges.some((s) => s.node.id === pins.serviceId && s.node.name === "web")) throw new Error("The pinned service does not match. Nothing was changed.");
if (!(await keychain("cloudflare-dns-token"))) throw new Error("No Cloudflare DNS token in Keychain runport-prod. Nothing was changed.");
console.log("railway targets checked");

// 1. The dashboard's Appwrite project. "dashboard" is a reserved slug, and an
// existing project must be ours (its name and its server key) before any
// setting on it changes.
const admin = new AppwriteAdmin();
const existing = await admin.getProject(pins.appwriteProjectId);
let appwriteKey = await keychain("dashboard-appwrite-key");
if (existing) {
  if (existing.name !== pins.appwriteProjectName || !appwriteKey) throw new Error("An Appwrite project called dashboard exists but is not the dashboard's. Nothing was changed.");
  // Our key must open the project and find the dashboard's own deletions table.
  const own = await fetch(`${config.endpoint}/tablesdb/main/tables/deletions`, { headers: { "X-Appwrite-Project": pins.appwriteProjectId, "X-Appwrite-Key": appwriteKey } });
  if (!own.ok) throw new Error("The dashboard's stored Appwrite key does not open the dashboard project. Nothing was changed.");
} else {
  await admin.createProject(pins.appwriteProjectId, pins.appwriteProjectName);
  appwriteKey = (await admin.createServerKey(pins.appwriteProjectId, "dashboard-online")).secret;
  await writeSecret("dashboard-appwrite-key", appwriteKey, "runport-prod");
}
for (const host of [pins.domain, "localhost"]) await admin.addWebPlatform(pins.appwriteProjectId, host).catch(() => {});
// Login codes go through the gateway's dedicated login identity.
await admin.setProjectSmtp(pins.appwriteProjectId, loginSmtp(pins.appwriteProjectId, "Runport", await readSecret("mail-master-key", "runport-prod"), config.mailDomain));
console.log("appwrite project ready");

// 2. Only email codes may sign in.
{
  const res = await fetch(`${config.endpoint}/account/sessions/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Appwrite-Project": "console" },
    body: JSON.stringify({ email: await readSecret("appwrite-owner-email", "runport-prod"), password: await readSecret("appwrite-owner-password", "runport-prod") }),
  });
  if (!res.ok) throw new Error(`Appwrite console sign-in failed (${res.status}).`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  for (const method of ["email-password", "magic-url", "anonymous", "invites", "phone"]) {
    const r = await fetch(`${config.endpoint}/projects/${pins.appwriteProjectId}/auth/${method}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Appwrite-Project": "console", Cookie: cookie },
      body: JSON.stringify({ enabled: false }),
    });
    if (!r.ok) throw new Error(`Could not turn off ${method} sign-in (${r.status}).`);
  }
  await fetch(`${config.endpoint}/account/sessions/current`, { method: "DELETE", headers: { "X-Appwrite-Project": "console", Cookie: cookie } });
}

// 3. Tables and the backup bucket.
const env = { ...process.env, APPWRITE_ENDPOINT: config.endpoint, APPWRITE_PROJECT_ID: pins.appwriteProjectId, APPWRITE_API_KEY: appwriteKey };
const setup = Bun.spawn(["bun", "run", "setup"], { cwd: folder, env, stdout: "ignore", stderr: "ignore" });
if ((await setup.exited) !== 0) throw new Error("Dashboard table setup failed.");

// 4. The trusted app list and per-app keys.
type Vars = { variables: Record<string, string> };
const current = (await railwayApi<Vars>(
  "query($p: String!, $e: String!, $s: String!) { variables(projectId: $p, environmentId: $e, serviceId: $s) }",
  { p: pins.projectId, e: pins.environmentId, s: pins.serviceId },
)).variables;
let existingKeys: Record<string, KeyPair> = {};
try {
  existingKeys = JSON.parse(current.RUNPORT_APP_KEYS ?? "{}");
} catch {
  existingKeys = {};
}
const sync = await syncDashboard({ workspaceId: pins.workspaceId, mintKeysFor, existingKeys, extraRegistry: process.env.DASHBOARD_EXTRA_REGISTRY }, appwriteKey);
console.log(`apps pinned: ${sync.synced.join(", ") || "none"}${sync.withoutKeys.length ? ` (no keys yet: ${sync.withoutKeys.join(", ")})` : ""}`);

// 5. Settings through the API, then remove settings older versions used.
const railwayToken = await keychain("dashboard-railway-token");
if (!railwayToken) console.warn("No dashboard-railway-token in the Keychain: cost, status and actions stay off.");
const variables: Record<string, string> = {
  APPWRITE_ENDPOINT: config.endpoint,
  APPWRITE_PROJECT_ID: pins.appwriteProjectId,
  APPWRITE_API_KEY: appwriteKey,
  APP_URL: `https://${pins.domain}`,
  PORT: pins.port,
  NEXT_TELEMETRY_DISABLED: "1",
  DASHBOARD_OWNER_EMAILS: await readSecret("owner-email", "runport-prod"),
  RAILWAY_WORKSPACE_ID: pins.workspaceId,
  ANALYTICS_URL: "https://analytics.runport.app",
  ANALYTICS_USERNAME: "runport-dashboard",
  ANALYTICS_PASSWORD: await readSecret("analytics-dashboard-password", "runport-prod"),
  RUNPORT_APP_KEYS: JSON.stringify(sync.keys),
  ...(railwayToken ? { RAILWAY_API_TOKEN: railwayToken } : {}),
};
await railwayApi(
  "mutation($i: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $i) }",
  { i: { projectId: pins.projectId, environmentId: pins.environmentId, serviceId: pins.serviceId, variables, skipDeploys: true } },
);
for (const name of ["APPWRITE_CONSOLE_EMAIL", "APPWRITE_CONSOLE_PASSWORD", "ANALYTICS_ADMIN_PASSWORD"]) {
  if (name in current) {
    await railwayApi("mutation($i: VariableDeleteInput!) { variableDelete(input: $i) }", {
      i: { projectId: pins.projectId, environmentId: pins.environmentId, serviceId: pins.serviceId, name },
    });
  }
}
await railwayApi(
  "mutation($s: String!, $e: String!) { serviceInstanceUpdate(serviceId: $s, environmentId: $e, input: { sleepApplication: true }) }",
  { s: pins.serviceId, e: pins.environmentId },
);
console.log("settings saved");

// 6. Deploy the folder to the pinned project, environment and service by id.
if (!process.argv.includes("--no-deploy")) {
  const up = Bun.spawn(["railway", "up", folder, "--path-as-root", "--project", pins.projectId, "--environment", pins.environmentId, "--service", pins.serviceId, "--detach"], {
    cwd: folder, stdout: "ignore", stderr: "ignore",
  });
  if ((await up.exited) !== 0) throw new Error("railway up failed. Run it again; nothing else changed.");
  console.log("deploy started");
}
console.log(`The address ${pins.domain} is already set up; for a new one run: bun src/custom-domain.ts ${pins.domain} web ${pins.port} ${folder} (after checking that folder's Railway link is ${pins.projectName}).`);
