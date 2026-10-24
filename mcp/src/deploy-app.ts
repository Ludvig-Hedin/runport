// Puts an app from ~/Programming/apps online: an Appwrite project on the
// online Runport, then a Railway project for the app itself.
// Run: PLATFORM_KEYCHAIN_SERVICE=runport-prod PLATFORM_APPWRITE_ENDPOINT=https://<runport>/v1 bun src/deploy-app.ts <slug>
// Safe to rerun: each step checks what exists first.
import { homedir } from "node:os";
import { join } from "node:path";
import { AppwriteAdmin } from "./appwrite-admin";
import { config } from "./config";
import { readSecret } from "./keychain";
import { loadRegistry } from "./registry";
import { assertAppwriteId } from "./slug";

const slug = assertAppwriteId(process.argv[2] ?? "");
const app = (await loadRegistry()).apps.find((a) => a.slug === slug);
if (!app) throw new Error(`No app called "${slug}" in ${config.appsDir}.`);
const admin = new AppwriteAdmin();

/** Runs the Railway CLI in the app folder. Output is returned, never printed, as it can hold keys. */
async function railway(args: string[], input?: string): Promise<string> {
  const proc = Bun.spawn(["railway", ...args], { cwd: app!.folder, stdin: input ? new Blob([input]) : "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`railway ${args[0]} failed: ${err.trim() || out.trim()}`);
  return out;
}

/**
 * Lets the app sleep after about 10 idle minutes; the next visit wakes it in a
 * few seconds. The CLI has no flag for this, so it goes through Railway's API
 * with the CLI's own login. Takes effect from the deploy below.
 */
async function sleepWhenIdle(): Promise<void> {
  type Status = { environments: { edges: { node: { id: string; name: string } }[] }; services: { edges: { node: { id: string; name: string } }[] } };
  const status = JSON.parse(await railway(["status", "--json"])) as Status;
  const environmentId = status.environments.edges.find((e) => e.node.name === "production")?.node.id;
  const serviceId = status.services.edges.find((s) => s.node.name === "web")?.node.id;
  const login = JSON.parse(await Bun.file(join(homedir(), ".railway", "config.json")).text()) as { user?: { accessToken?: string; token?: string } };
  const token = process.env.RAILWAY_API_TOKEN ?? login.user?.accessToken ?? login.user?.token;
  if (!environmentId || !serviceId || !token) throw new Error("Could not find the Railway service or login to turn on sleeping.");
  const res = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: "mutation($s: String!, $e: String!) { serviceInstanceUpdate(serviceId: $s, environmentId: $e, input: { sleepApplication: true }) }",
      variables: { s: serviceId, e: environmentId },
    }),
  });
  const body = (await res.json()) as { errors?: { message: string }[] };
  if (!res.ok || body.errors) throw new Error(`Railway refused to turn on sleeping: ${body.errors?.map((e) => e.message).join("; ") ?? res.status}`);
}

// 1. Railway project and service with a public domain.
const linked = await railway(["status", "--json"]).then(
  (out) => JSON.parse(out) as { name: string },
  () => null,
);
if (!linked) await railway(["init", "--name", `${slug}-app`, "--json"]);
const services = JSON.parse(await railway(["status", "--json"])).services.edges as { node: { name: string } }[];
if (!services.some((s) => s.node.name === "web")) await railway(["add", "--service", "web"]);
await sleepWhenIdle();
const domainOut = JSON.parse(await railway(["domain", "--service", "web", "--json"])) as { domain?: string; domains?: string[] };
const domain = new URL(domainOut.domain ?? domainOut.domains?.[0] ?? "").host;
console.log(`app address: https://${domain}`);

// 2. Appwrite project on the online Runport.
if (!(await admin.getProject(slug))) await admin.createProject(slug, app.name);
await admin.addWebPlatform(slug, domain);
const masterKey = await readSecret("mail-gateway-master-key");
await admin.setProjectSmtp(slug, {
  senderName: app.name,
  senderEmail: `${slug}@${config.mailDomain}`,
  host: "mail-gateway.railway.internal",
  port: 2525,
  username: slug,
  password: new Bun.CryptoHasher("sha256", masterKey).update(`mail-gateway:${slug}`).digest("hex"),
});
// Reuse the key already stored on Railway, so reruns do not pile up keys.
const current = JSON.parse(await railway(["variables", "--service", "web", "--json"])) as Record<string, string>;
const key = current.APPWRITE_PROJECT_ID === slug && current.APPWRITE_API_KEY
  ? current.APPWRITE_API_KEY
  : (await admin.createServerKey(slug, `${slug}-online`)).secret;
console.log("appwrite project ready");

// 3. Tables, using the new key.
const env = { ...process.env, APPWRITE_ENDPOINT: config.endpoint, APPWRITE_PROJECT_ID: slug, APPWRITE_API_KEY: key };
const setup = Bun.spawn(["bun", "run", "setup"], { cwd: app.folder, env, stdout: "ignore", stderr: "pipe" });
if ((await setup.exited) !== 0) throw new Error(`Table setup failed: ${await new Response(setup.stderr).text()}`);
console.log("tables ready");

// 4. App settings on Railway, then deploy the folder.
// Telemetry off, so an idle app sends nothing out and Railway can put it to sleep.
const vars = { APPWRITE_ENDPOINT: config.endpoint, APPWRITE_PROJECT_ID: slug, APPWRITE_API_KEY: key, APP_URL: `https://${domain}`, PORT: String(app.port), NEXT_TELEMETRY_DISABLED: "1" };
await railway(["variables", "--service", "web", "--skip-deploys", ...Object.entries(vars).flatMap(([k, v]) => ["--set", `${k}=${v}`])]);
await railway(["up", join(app.folder), "--path-as-root", "--service", "web", "--detach"]);
console.log("deploy started");
