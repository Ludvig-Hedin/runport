// Puts an app from ~/Programming/apps online: an Appwrite project on the
// online Sitedock, then a Railway project for the app itself.
// Run: PLATFORM_KEYCHAIN_SERVICE=sitedock-prod PLATFORM_APPWRITE_ENDPOINT=https://<sitedock>/v1 bun src/deploy-app.ts <slug>
// Safe to rerun: each step checks what exists first.
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

// 1. Railway project and service with a public domain.
const linked = await railway(["status", "--json"]).then(
  (out) => JSON.parse(out) as { name: string },
  () => null,
);
if (!linked) await railway(["init", "--name", `${slug}-app`, "--json"]);
const services = JSON.parse(await railway(["status", "--json"])).services.edges as { node: { name: string } }[];
if (!services.some((s) => s.node.name === "web")) await railway(["add", "--service", "web"]);
const domainOut = JSON.parse(await railway(["domain", "--service", "web", "--json"])) as { domain?: string; domains?: string[] };
const domain = new URL(domainOut.domain ?? domainOut.domains?.[0] ?? "").host;
console.log(`app address: https://${domain}`);

// 2. Appwrite project on the online Sitedock.
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
const vars = { APPWRITE_ENDPOINT: config.endpoint, APPWRITE_PROJECT_ID: slug, APPWRITE_API_KEY: key, APP_URL: `https://${domain}`, PORT: String(app.port) };
await railway(["variables", "--service", "web", "--skip-deploys", ...Object.entries(vars).flatMap(([k, v]) => ["--set", `${k}=${v}`])]);
await railway(["up", join(app.folder), "--path-as-root", "--service", "web", "--detach"]);
console.log("deploy started");
