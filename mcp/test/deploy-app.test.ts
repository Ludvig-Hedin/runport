import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { websiteId } from "../src/analytics";

test.each(["deploy", "backfill"] as const)("%s registers app alerts with the expected scope", async (operation) => {
  const root = await mkdtemp(join(tmpdir(), "runport-deploy-fixture-"));
  try {
    const slug = operation === "backfill" ? "todo" : "fixture-app";
    const domain = "fixture.up.railway.app";
    const folder = join(root, slug);
    const bin = join(root, "bin");
    const events = join(root, "events.jsonl");
    const registry = join(root, ".platform.json");
    const analyticsSecret = "a".repeat(64);
    const master = "isolated-test-mail-master";
    const projectId = "00000000-0000-0000-0000-000000000001";
    const environmentId = "00000000-0000-0000-0000-000000000002";
    const serviceId = "00000000-0000-0000-0000-000000000003";
    const workspaceId = "00000000-0000-0000-0000-000000000004";
    const registrationId = "00000000-0000-0000-0000-000000000006";
    const webhookId = "00000000-0000-0000-0000-000000000005";
    const project = {
      id: projectId, workspaceId, name: `${slug}-app`,
      environments: { edges: [{ node: { name: "production", id: environmentId } }] },
      services: { edges: [{ node: { name: "web", id: serviceId } }] },
    };
    await mkdir(bin);
    for (const [path, data] of Object.entries({
      "app/layout.tsx": "<VisitorAnalytics />",
      "lib/analytics-server.ts": "ANALYTICS_INGEST_TOKEN",
      "lib/analytics-policy.ts": "fixture",
      "app/visitor-analytics.tsx": "fixture",
      "app/runport-metrics/tracker.js/route.ts": "fixture",
      "app/runport-metrics/api/send/route.ts": "fixture",
      "package.json": JSON.stringify({ scripts: { setup: "bun setup.ts" } }),
      "setup.ts": "console.log('isolated setup');",
    })) {
      const file = join(folder, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, data);
    }
    const initialRegistry = JSON.stringify({ ...(operation === "backfill" ? { registryPeerField: "kept" } : {}),
      apps: [{ slug, name: "Deployment fixture", projectId: slug, folder, port: 3101,
      git: "github", repoUrl: null, createdByPlatform: true, createdAt: "2026-11-27T00:00:00Z",
      ...(operation === "backfill" ? { peerField: "kept", alerts: { accountMaintenance: true, peerField: "kept" } } : {}),
    }] });
    await writeFile(registry, initialRegistry);
    await writeFile(join(root, "registry.backup.json"), initialRegistry);
    await writeFile(join(bin, "railway"), `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = Bun.argv.slice(2);
const stdin = args.includes("--stdin") ? await new Response(Bun.stdin.stream()).text() : undefined;
appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify({ command: "railway", args, stdin }) + "\\n");
if (args[0] === "status") console.log(JSON.stringify(${JSON.stringify(project)}));
else if (args[0] === "domain") console.log(JSON.stringify({ domain: "https://${domain}" }));
else if (args[0] === "variables" && args.includes("--json")) console.log(JSON.stringify({
  APPWRITE_PROJECT_ID: "${slug}", APPWRITE_API_KEY: "fixture-api-key", RUNPORT_FORM_OWNER_EMAIL: "owner@example.test",
}));
else if (!["up", "variable", "variables"].includes(args[0])) throw new Error("Unexpected Railway command");
`, { mode: 0o700 });
    await writeFile(join(bin, "security"), `#!${process.execPath}
const args = Bun.argv.slice(2);
const items = {
  "appwrite-owner-email": "owner@example.test", "appwrite-owner-password": "fixture-owner-secret",
  "mail-master-key": "${master}",
};
const key = args[args.indexOf("-a") + 1];
if (args[args.indexOf("-s") + 1] !== "deploy-fixture" || !Object.hasOwn(items, key)) throw new Error("Unexpected Keychain lookup");
console.log(items[key]);
`, { mode: 0o700 });
    const preload = join(root, "fixture-fetch.ts");
    await writeFile(preload, `
import { appendFileSync } from "node:fs";
globalThis.fetch = async (input, options) => {
  const url = new URL(String(input));
  const method = options?.method ?? "GET";
  const body = options?.body ? JSON.parse(options.body) : undefined;
  appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify({ method, url: url.href, body }) + "\\n");
  if (url.href === "https://backboard.railway.com/graphql/v2") {
    if (options.headers.Authorization !== "Bearer fixture-railway-token") throw new Error("Unexpected Railway credential");
    if (body.query.includes("serviceDomains")) return Response.json({data:{serviceInstance:{domains:{serviceDomains:[{domain:"${domain}"}]}}}});
    if (body.query.includes("notificationRules")) return Response.json({data:{notificationRules:[]}});
    if (body.query.includes("notificationRuleCreate")) return Response.json({data:{notificationRuleCreate:{id:"${webhookId}"}}});
    return Response.json({ data: { serviceInstanceUpdate: true } });
  }
  if (url.href === "https://appwrite.example.test/v1/account/sessions/email")
    return Response.json({}, { headers: { "Set-Cookie": "fixture=session; Path=/" } });
  if (url.href === "https://appwrite.example.test/v1/projects/${slug}") return Response.json({ $id: "${slug}" });
  if (url.href === "https://appwrite.example.test/v1/projects/${slug}/platforms")
    return Response.json({ platforms: [{ hostname: "${domain}" }] });
  if (url.href === "https://appwrite.example.test/v1/project/smtp") return Response.json({});
  if (url.href === "https://analytics.example.test/api/auth/login")
    return Response.json({ token: "fixture-analytics-admin", user: { role: "user" } });
  if (url.origin === "https://analytics.example.test" && url.pathname.startsWith("/api/websites/"))
    return new Response(null, { status: 404 });
  if (url.href === "https://analytics.example.test/api/websites" && method === "POST")
    return Response.json({ id: body.id, domain: body.domain });
  if (url.href === "https://alerts.example.test/_runport/alerts/register/${slug}" && method === "POST")
    return new Response(null, { status: 204, headers: { "X-Runport-Registration-Id": "${registrationId}" } });
  throw new Error("Network access outside the isolated deploy fixture: " + url.href);
};
`);
    const script = operation === "backfill" ? "backfill-app-alerts.ts" : "deploy-app.ts";
    const proc = Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "../src", script), slug], {
      cwd: root,
      env: {
        PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
        FIXTURE_EVENTS: events, RAILWAY_API_TOKEN: "fixture-railway-token",
        PLATFORM_APPS_DIR: root, PLATFORM_KEYCHAIN_SERVICE: "deploy-fixture",
        PLATFORM_APPWRITE_ENDPOINT: "https://appwrite.example.test/v1", PLATFORM_ALERT_ORIGIN: "https://alerts.example.test",
        PLATFORM_ANALYTICS_URL: "https://analytics.example.test", PLATFORM_ANALYTICS_USERNAME: "fixture",
        PLATFORM_ANALYTICS_PASSWORD: "fixture", PLATFORM_ANALYTICS_INGEST_SECRET: analyticsSecret,
      },
      stdout: "pipe", stderr: "pipe",
    });
    const [out, err, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (exit !== 0) throw new Error(out + err);
    const calls = (await readFile(events, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    if (operation === "backfill") {
      const call = calls.find(event => event.url === `https://alerts.example.test/_runport/alerts/register/${slug}`);
      expect(call.body).toEqual({ slug, projectId, environmentId, serviceId, domain });
      expect(calls.some(event => event.args?.[0] === "up")).toBe(false);
      const { apps, registryPeerField } = JSON.parse(await readFile(registry, "utf8"));
      expect(registryPeerField).toBe("kept");
      expect(apps).toHaveLength(1);
      expect(apps[0]).toMatchObject({ peerField: "kept", alerts: { accountMaintenance: true, peerField: "kept", registrationId } });
      const [backup] = (await readdir(root)).filter(name => name.startsWith(".platform.json.alerts-backup-"));
      expect(await readFile(join(root, backup!), "utf8")).toBe(initialRegistry);
      return;
    }
    const siteId = websiteId(slug);
    const analytics = calls.findIndex(call => call.url === "https://analytics.example.test/api/websites");
    const registration = calls.findIndex(call => call.url === `https://alerts.example.test/_runport/alerts/register/${slug}`);
    const webhook = calls.findIndex(call => call.body?.query?.includes("notificationRuleCreate"));
    const deploy = calls.findIndex(call => call.args?.[0] === "up");
    expect(analytics).toBeGreaterThanOrEqual(0);
    expect(registration).toBeGreaterThan(analytics);
    expect(webhook).toBeGreaterThan(registration);
    expect(deploy).toBeGreaterThan(webhook);
    expect(calls[analytics].body).toMatchObject({ id: siteId, domain });
    expect(calls[registration].body).toEqual({ slug, projectId, environmentId, serviceId, domain });
    const webhookSecret = createHmac("sha256", master).update(`runport-app-alerts:railway:${slug}:${projectId}:${environmentId}:${serviceId}:${registrationId}`).digest("hex");
    const webhookBinding = createHmac("sha256", master).update(`runport-app-alerts:railway-url:v1:${slug}:${projectId}:${environmentId}:${serviceId}:${registrationId}`).digest("hex").slice(0, 24);
    expect(calls[webhook].body.variables.input).toMatchObject({
      projectId, workspaceId, ephemeralEnvironments: false,
      channelConfigs: [{type: "webhook", url: `https://alerts.example.test/_runport/alerts/railway/${slug}?binding=${webhookBinding}`,
        headers: {Authorization: `Bearer ${webhookSecret}`}}],
    });
    expect(out + err).not.toContain(webhookSecret);
    expect(calls.find(call => call.url?.endsWith("/project/smtp")).body.username).toBe(`${slug}:login`);
    const variables = calls.find(call => call.args?.[0] === "variables" && call.args.includes("--set")).args;
    expect(variables).toContain(`ANALYTICS_SITE_ID=${siteId}`);
    expect(variables).toContain("ANALYTICS_URL=https://analytics.example.test");
    expect(variables).toContain(`RUNPORT_ERROR_URL=https://alerts.example.test/_runport/alerts/report/${slug}`);
    const staged = (name: string) => calls.slice(0, deploy).find(call => call.args?.[0] === "variable" && call.args.at(-1) === name);
    expect(staged("ANALYTICS_INGEST_TOKEN")?.stdin).toBe(createHmac("sha256", analyticsSecret).update(`runport:analytics:ingest:v1:${siteId}`).digest("hex"));
    expect(staged("RUNPORT_ERROR_TOKEN")?.stdin).toBe(createHmac("sha256", master).update(`runport-app-alerts:report:${slug}:${serviceId}:${environmentId}`).digest("hex"));
    const { apps } = JSON.parse(await readFile(registry, "utf8"));
    const original = JSON.parse(await readFile(join(root, "registry.backup.json"), "utf8")).apps;
    expect(apps).toHaveLength(original.length);
    expect(apps[0]).toMatchObject({ ...original[0], alerts: { environmentId, serviceId } });
    expect(apps[0].alerts.registrationId).toBe(registrationId);
    expect(apps[0].alerts.webhook).toEqual({ id: webhookId, projectId, workspaceId });
    expect(JSON.stringify(apps)).not.toContain(webhookSecret);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
