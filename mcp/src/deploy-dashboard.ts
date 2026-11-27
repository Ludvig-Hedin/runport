// Puts Runport's own dashboard (the repo's dashboard/ folder) online at
// dash.runport.app, in its own Railway project "runport-dashboard", so it
// never touches the runport project's config. Safe to rerun.
// Run: PLATFORM_KEYCHAIN_SERVICE=runport-prod PLATFORM_APPWRITE_ENDPOINT=https://admin.runport.app/v1 bun src/deploy-dashboard.ts
//
// Secrets come from Keychain runport-prod and go to Railway through its API,
// never through command-line arguments or logs.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AppwriteAdmin, AppwriteError } from "./appwrite-admin";
import { config } from "./config";
import { readSecret } from "./keychain";

const PROJECT = "runport-dashboard";
const SLUG = "dashboard";
const DOMAIN = "dash.runport.app";
const PORT = "3000";
const folder = resolve(import.meta.dir, "..", "..", "dashboard");

async function railway(args: string[]): Promise<string> {
  const proc = Bun.spawn(["railway", ...args], { cwd: folder, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`railway ${args[0]} failed: ${(err || out).trim()}`);
  return out;
}

const login = JSON.parse(await Bun.file(join(homedir(), ".railway", "config.json")).text()) as { user?: { accessToken?: string } };
const accountToken = login.user?.accessToken;
if (!accountToken) throw new Error("Log in to Railway first (railway login).");

async function gql<T>(query: string, variables: Record<string, unknown>, token = accountToken!): Promise<T> {
  const res = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (!res.ok || body.errors || !body.data) throw new Error(`Railway: ${body.errors?.map((e) => e.message).join("; ") ?? res.status}`);
  return body.data;
}

async function keychain(account: string): Promise<string | null> {
  const proc = Bun.spawn(["security", "find-generic-password", "-s", "runport-prod", "-a", account, "-w"], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(proc.stdout).text()).trim();
  return (await proc.exited) === 0 && out ? out : null;
}

async function storeKeychain(account: string, value: string): Promise<void> {
  // -U updates an existing item. `security` only takes the value as an
  // argument; it is a short-lived local process, never logged.
  const proc = Bun.spawn(["security", "add-generic-password", "-U", "-s", "runport-prod", "-a", account, "-w", value], { stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`Could not store ${account} in the Keychain.`);
}

// 0. The DNS token must exist before anything registers the domain.
if (!(await keychain("cloudflare-dns-token"))) throw new Error("No Cloudflare DNS token in Keychain runport-prod. Nothing was changed.");

// 1. The Railway project. A folder without its own link inherits a parent's,
// so the linked project must be exactly runport-dashboard.
const workspaceId = (await gql<{ me: { workspaces: { id: string }[] } }>("{ me { workspaces { id } } }", {})).me.workspaces[0]?.id;
if (!workspaceId) throw new Error("No Railway workspace.");
const linked = await railway(["status", "--json"]).then((out) => JSON.parse(out) as { name: string }, () => null);
if (linked && linked.name !== PROJECT) throw new Error(`dashboard/ is linked to "${linked.name}", not "${PROJECT}". Nothing was changed.`);
if (!linked) {
  const projects = await gql<{ workspace: { projects: { edges: { node: { id: string; name: string } }[] } } }>(
    "query($w: String!) { workspace(workspaceId: $w) { projects { edges { node { id name } } } } }",
    { w: workspaceId },
  );
  const existing = projects.workspace.projects.edges.find((e) => e.node.name === PROJECT);
  if (existing) await railway(["link", "--project", existing.node.id, "--environment", "production"]);
  else await railway(["init", "--name", PROJECT, "--json"]);
}
type Status = { id: string; environments: { edges: { node: { id: string; name: string } }[] }; services: { edges: { node: { id: string; name: string } }[] } };
let status = JSON.parse(await railway(["status", "--json"])) as Status;
if (!status.services.edges.some((s) => s.node.name === "web")) {
  await railway(["add", "--service", "web"]);
  status = JSON.parse(await railway(["status", "--json"])) as Status;
}
const projectId = status.id;
const environmentId = status.environments.edges.find((e) => e.node.name === "production")!.node.id;
const serviceId = status.services.edges.find((s) => s.node.name === "web")!.node.id;
await gql("mutation($s: String!, $e: String!) { serviceInstanceUpdate(serviceId: $s, environmentId: $e, input: { sleepApplication: true }) }", { s: serviceId, e: environmentId });
const domainOut = JSON.parse(await railway(["domain", "--service", "web", "--json"])) as { domain?: string; domains?: string[] };
const railwayDomain = new URL(domainOut.domain ?? domainOut.domains?.find((d) => d.includes(".up.railway.app")) ?? "").host;
console.log(`railway project ${PROJECT} ready`);

// 2. The dashboard's own Appwrite project: sign-in, its tables and the backup bucket.
const admin = new AppwriteAdmin();
if (!(await admin.getProject(SLUG))) await admin.createProject(SLUG, "Runport dashboard");
for (const host of [DOMAIN, railwayDomain, "localhost"]) {
  await admin.addWebPlatform(SLUG, host).catch((e) => {
    if (!(e instanceof AppwriteError && e.status === 409)) throw e;
  });
}
const masterKey = await readSecret("mail-gateway-master-key");
await admin.setProjectSmtp(SLUG, {
  senderName: "Runport",
  senderEmail: `${SLUG}@${config.mailDomain}`,
  host: "mail-gateway.railway.internal",
  port: 2525,
  username: SLUG,
  password: new Bun.CryptoHasher("sha256", masterKey).update(`mail-gateway:${SLUG}`).digest("hex"),
});
let appwriteKey = await keychain("dashboard-appwrite-key");
if (!appwriteKey) {
  appwriteKey = (await admin.createServerKey(SLUG, "dashboard-online")).secret;
  await storeKeychain("dashboard-appwrite-key", appwriteKey);
}
console.log("appwrite project ready");

// 3. The dashboard's Railway workspace token. Railway only lets a person make
// one (Account settings > Tokens, workspace "ludvig-hedin's Projects"); store
// it once with: security add-generic-password -s runport-prod -a dashboard-railway-token -w
// Without it the dashboard runs, and its Railway blocks say they can't load.
const railwayToken = await keychain("dashboard-railway-token");
if (!railwayToken) console.warn("No dashboard-railway-token in the Keychain: cost, status and actions stay off.");

// 4. Tables and bucket, then the Mac's app list.
const env = { ...process.env, APPWRITE_ENDPOINT: config.endpoint, APPWRITE_PROJECT_ID: SLUG, APPWRITE_API_KEY: appwriteKey };
for (const script of ["setup", "sync-apps"]) {
  const proc = Bun.spawn(["bun", "run", script], { cwd: folder, env, stdout: "inherit", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`${script} failed: ${await new Response(proc.stderr).text()}`);
}

// 5. Settings, through the API so no secret lands in a process list.
const owner = await readSecret("owner-email");
const variables: Record<string, string> = {
  APPWRITE_ENDPOINT: config.endpoint,
  APPWRITE_PROJECT_ID: SLUG,
  APPWRITE_API_KEY: appwriteKey,
  APP_URL: `https://${DOMAIN}`,
  PORT,
  NEXT_TELEMETRY_DISABLED: "1",
  DASHBOARD_OWNER_EMAILS: owner,
  ...(railwayToken ? { RAILWAY_API_TOKEN: railwayToken } : {}),
  RAILWAY_WORKSPACE_ID: workspaceId,
  ANALYTICS_URL: "https://analytics.runport.app",
  ANALYTICS_ADMIN_PASSWORD: await readSecret("analytics-admin-password"),
  APPWRITE_CONSOLE_EMAIL: await readSecret("appwrite-owner-email"),
  APPWRITE_CONSOLE_PASSWORD: await readSecret("appwrite-owner-password"),
};
await gql(
  "mutation($i: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $i) }",
  { i: { projectId, environmentId, serviceId, variables, skipDeploys: true } },
);
console.log("settings saved");

// 6. Deploy the folder.
await railway(["up", folder, "--path-as-root", "--service", "web", "--detach"]);
console.log(`deploy started. Next: bun src/custom-domain.ts ${DOMAIN} web ${PORT} ${folder}`);
