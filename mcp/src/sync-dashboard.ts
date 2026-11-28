// Fills the dashboard's trusted app list from this Mac's app registry.
// For each app it pins the ids the dashboard may act on (Railway workspace,
// project, environment, service and the Appwrite project), checked against
// the app folder's own Railway link and Railway's API. It also makes the two
// small Appwrite keys per app the dashboard uses (read only, and
// project.write for a verified delete) and lets the dashboard's view-only
// stats account see the app's analytics site.
//
// Used by deploy-dashboard.ts. Run alone with:
//   PLATFORM_KEYCHAIN_SERVICE=runport-prod PLATFORM_APPWRITE_ENDPOINT=https://admin.runport.app/v1 bun src/sync-dashboard.ts [--keys=all|none|slug,slug]
import { websiteId } from "./analytics";
import { config } from "./config";
import { readSecret } from "./keychain";
import { railwayApi } from "./railway-api";
import { type AppRecord, loadRegistry } from "./registry";
import { isValidSlug, RESERVED_SLUGS } from "./slug";

export type KeyPair = { read: string; write: string };
export type SyncOptions = { workspaceId: string; mintKeysFor: "all" | Set<string>; existingKeys: Record<string, KeyPair>; extraRegistry?: string };
type Pinned = { slug: string; name: string; repoUrl: string | null; git: string; workspaceId: string; railwayProjectId: string; environmentId: string; serviceId: string; appwriteProjectId: string; analyticsSiteId: string | null };

export const READ_SCOPES = ["project.read", "users.read", "teams.read", "functions.read", "databases.read", "tables.read", "columns.read", "indexes.read", "rows.read", "buckets.read", "files.read"];
/** project.write deletes and switches services; keys.* expires and restores the app's other keys during a delete. */
export const WRITE_SCOPES = ["project.write", "keys.read", "keys.write"];

const endpoint = () => config.endpoint.replace(/\/+$/, "");

/** Console calls as the owner, from this Mac only. Errors carry only status codes. */
export async function consoleSession() {
  const res = await fetch(`${endpoint()}/account/sessions/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Appwrite-Project": "console" },
    body: JSON.stringify({ email: await readSecret("appwrite-owner-email"), password: await readSecret("appwrite-owner-password") }),
  });
  if (!res.ok) throw new Error(`Appwrite console sign-in failed (${res.status}).`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await fetch(`${endpoint()}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Appwrite-Project": "console", Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw Object.assign(new Error(`Appwrite ${method} ${path.split("?")[0]} answered ${r.status}.`), { status: r.status });
    return (r.status === 204 ? undefined : await r.json()) as T;
  };
  return { call, close: () => call("DELETE", "/account/sessions/current").catch(() => {}) };
}

async function railwayLink(app: AppRecord): Promise<{ id: string; name: string; environmentId: string; serviceId: string }> {
  const proc = Bun.spawn(["railway", "status", "--json"], { cwd: app.folder, stdout: "pipe", stderr: "ignore" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`${app.slug}: its folder has no Railway link.`);
  const s = JSON.parse(out) as { id: string; name: string; environments: { edges: { node: { id: string; name: string } }[] }; services: { edges: { node: { id: string; name: string } }[] } };
  const environmentId = s.environments.edges.find((e) => e.node.name === "production")?.node.id;
  const serviceId = s.services.edges.find((e) => e.node.name === "web")?.node.id;
  if (s.name !== `${app.slug}-app` || !environmentId || !serviceId) throw new Error(`${app.slug}: its folder is linked to the wrong Railway project.`);
  return { id: s.id, name: s.name, environmentId, serviceId };
}

/**
 * Proves the Appwrite project belongs to this app before any key is made for
 * it: the app's own Railway settings must name that project on this Runport,
 * and the app's own server key must open it.
 */
async function proveAppwrite(app: AppRecord, link: { id: string; environmentId: string; serviceId: string }): Promise<void> {
  if (RESERVED_SLUGS.has(app.projectId) || app.projectId === "dashboard") throw new Error(`${app.slug}: its Appwrite id is reserved for the platform.`);
  const { variables } = await railwayApi<{ variables: Record<string, string> }>(
    "query($p: String!, $e: String!, $s: String!) { variables(projectId: $p, environmentId: $e, serviceId: $s) }",
    { p: link.id, e: link.environmentId, s: link.serviceId },
  );
  const sameEndpoint = (variables.APPWRITE_ENDPOINT ?? "").replace(/\/+$/, "") === endpoint();
  if (!sameEndpoint || variables.APPWRITE_PROJECT_ID !== app.projectId || !variables.APPWRITE_API_KEY) {
    throw new Error(`${app.slug}: its hosting does not point at Appwrite project ${app.projectId} on this Runport.`);
  }
  const opens = await fetch(`${endpoint()}/tablesdb?queries[]=${encodeURIComponent(JSON.stringify({ method: "limit", values: [1] }))}`, {
    headers: { "X-Appwrite-Project": app.projectId, "X-Appwrite-Key": variables.APPWRITE_API_KEY },
  });
  if (!opens.ok) throw new Error(`${app.slug}: the app's own key does not open Appwrite project ${app.projectId} (${opens.status}).`);
}

/** Lets the dashboard's view-only account see the app's site, through the shared team. */
async function shareAnalytics(slug: string): Promise<string | null> {
  const base = "https://analytics.runport.app";
  const teamId = await readSecret("analytics-sites-team-id");
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "runport-provisioner", password: await readSecret("analytics-provisioner-password") }),
  });
  if (!login.ok) throw new Error(`Analytics sign-in failed (${login.status}).`);
  const { token } = (await login.json()) as { token: string };
  const h = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const id = websiteId(slug);
  const site = await fetch(`${base}/api/websites/${id}`, { headers: h });
  if (site.status === 404 || site.status === 401) return null;
  if (!site.ok) throw new Error(`Analytics lookup for ${slug} failed (${site.status}).`);
  const body = (await site.json()) as { teamId: string | null } | null;
  if (!body) return null;
  if (body.teamId !== teamId) {
    const moved = await fetch(`${base}/api/websites/${id}/transfer`, { method: "POST", headers: h, body: JSON.stringify({ teamId }) });
    if (!moved.ok) throw new Error(`Could not share ${slug}'s analytics with the dashboard (${moved.status}).`);
    const still = await fetch(`${base}/api/websites/${id}`, { headers: h });
    if (!still.ok) throw new Error(`The provisioner lost access to ${slug}'s analytics site.`);
  }
  return id;
}

async function keysFor(app: AppRecord, opts: SyncOptions, session: Awaited<ReturnType<typeof consoleSession>>): Promise<KeyPair | null> {
  const current = opts.existingKeys[app.slug];
  // Reuse only a pair whose write key still has exactly today's scopes.
  const listedNow = await session.call<{ keys: { name: string; scopes: string[] }[] }>("GET", `/projects/${app.projectId}/keys`);
  const writeNow = listedNow.keys.find((k) => k.name === "runport-dashboard-write");
  const scopesOk = !!writeNow && [...writeNow.scopes].sort().join() === [...WRITE_SCOPES].sort().join();
  if (current && scopesOk) {
    const check = await fetch(`${endpoint()}/project`, { headers: { "X-Appwrite-Project": app.projectId, "X-Appwrite-Key": current.read } });
    if (check.ok && ((await check.json()) as { $id: string }).$id === app.projectId) return current;
  }
  const allowed = opts.mintKeysFor === "all" || opts.mintKeysFor.has(app.slug);
  if (!allowed) return null;
  const listed = await session.call<{ keys: { $id: string; name: string }[] }>("GET", `/projects/${app.projectId}/keys`);
  for (const k of listed.keys.filter((k) => k.name.startsWith("runport-dashboard-"))) {
    await session.call("DELETE", `/projects/${app.projectId}/keys/${k.$id}`);
  }
  const make = (name: string, scopes: string[]) =>
    session.call<{ secret: string }>("POST", `/projects/${app.projectId}/keys`, { keyId: "unique()", name, scopes, expire: null }).then((k) => k.secret);
  return { read: await make("runport-dashboard-read", READ_SCOPES), write: await make("runport-dashboard-write", WRITE_SCOPES) };
}

/** Writes the pinned rows and returns the key map for RUNPORT_APP_KEYS. */
export async function syncDashboard(opts: SyncOptions, dashboardKey: string): Promise<{ keys: Record<string, KeyPair>; synced: string[]; withoutKeys: string[] }> {
  const registry = await loadRegistry();
  const extra = opts.extraRegistry ? (await loadRegistry(opts.extraRegistry)).apps : [];
  const apps = [...registry.apps, ...extra].filter((a) => !a.setupPending && isValidSlug(a.slug) && a.createdByPlatform);

  const projects = await railwayApi<{ workspace: { projects: { edges: { node: { id: string; name: string } }[] } } }>(
    "query($w: String!) { workspace(workspaceId: $w) { projects { edges { node { id name } } } } }",
    { w: opts.workspaceId },
  );
  const inWorkspace = new Map(projects.workspace.projects.edges.map((e) => [e.node.id, e.node.name]));

  const pinned: Pinned[] = [];
  for (const app of apps) {
    const link = await railwayLink(app);
    if (inWorkspace.get(link.id) !== `${app.slug}-app`) throw new Error(`${app.slug}: its Railway project is not in the Runport workspace.`);
    await proveAppwrite(app, link);
    pinned.push({
      slug: app.slug, name: app.name, repoUrl: app.repoUrl, git: app.git,
      workspaceId: opts.workspaceId, railwayProjectId: link.id, environmentId: link.environmentId, serviceId: link.serviceId,
      appwriteProjectId: app.projectId, analyticsSiteId: null,
    });
  }
  for (const key of ["slug", "railwayProjectId", "appwriteProjectId"] as const) {
    const values = pinned.map((p) => p[key]);
    const dup = values.find((v, i) => values.indexOf(v) !== i);
    if (dup) throw new Error(`Two apps share ${key} "${dup}". Fix the app list first; nothing was synced.`);
  }

  const session = await consoleSession();
  const keys: Record<string, KeyPair> = {};
  const withoutKeys: string[] = [];
  try {
    for (const p of pinned) {
      const app = apps.find((a) => a.slug === p.slug)!;
      p.analyticsSiteId = await shareAnalytics(p.slug);
      const pair = await keysFor(app, opts, session);
      if (pair) keys[p.slug] = pair;
      else withoutKeys.push(p.slug);
    }
  } finally {
    await session.close();
  }

  // The dashboard's table: one row per pinned app, row id = slug. Stale rows go.
  const db = (method: string, path: string, body?: unknown) =>
    fetch(`${endpoint()}/tablesdb/main/tables/apps${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Appwrite-Project": "dashboard", "X-Appwrite-Key": dashboardKey },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => {
      if (!r.ok && r.status !== 404) throw new Error(`Dashboard table ${method} answered ${r.status}.`);
      return r.status === 204 || !r.ok ? null : r.json();
    });
  const rows = (await db("GET", `/rows?queries[]=${encodeURIComponent(JSON.stringify({ method: "limit", values: [500] }))}`)) as { rows: { $id: string }[] };
  for (const p of pinned) await db("PUT", `/rows/${p.slug}`, { data: p });
  for (const r of rows.rows) if (!pinned.some((p) => p.slug === r.$id)) await db("DELETE", `/rows/${r.$id}`);
  return { keys, synced: pinned.map((p) => p.slug), withoutKeys };
}
