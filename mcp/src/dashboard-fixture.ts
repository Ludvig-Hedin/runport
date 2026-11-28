// A throwaway app for testing the dashboard's pause, resume and delete on
// real services, never on a real app. Each run gets a random name
// ("dfx-<random>"), its own Appwrite project and its own Railway project in
// the pinned Runport workspace, seeded with two test users (one with a
// password), three rows, a JSON file and a binary file. No email is sent: users
// are made with a server key on example.invalid addresses.
//
// Every resource is recorded in <dir>/fixture.json the moment it exists, and
// `remove` deletes only what that file records, after checking each is still
// the fixture's own. It never deletes a folder it did not create.
//
//   bun src/dashboard-fixture.ts create <new dir>   (the dir must not exist)
//   bun src/dashboard-fixture.ts remove <dir>
// Run with PLATFORM_KEYCHAIN_SERVICE=runport-prod PLATFORM_APPWRITE_ENDPOINT=https://admin.runport.app/v1.
import { cp, mkdir, readFile, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AppwriteAdmin } from "./appwrite-admin";
import { config } from "./config";
import { railwayApi } from "./railway-api";
import { consoleSession } from "./sync-dashboard";

const MARKER = "runport-dashboard-fixture-v1";
type State = { marker: string; slug: string; dir: string; appwriteProjectId?: string; railwayProjectId?: string; workspaceId: string };

const [command, dirArg] = process.argv.slice(2);
if (!dirArg || (command !== "create" && command !== "remove")) throw new Error("Usage: bun src/dashboard-fixture.ts create|remove <dir>");
const dir = resolve(dirArg);
const stateFile = join(dir, "fixture.json");
const pins = JSON.parse(await readFile(resolve(import.meta.dir, "..", "..", "dashboard", "runport.deploy.json"), "utf8")) as { workspaceId: string };
const admin = new AppwriteAdmin();
const exists = (p: string) => stat(p).then(() => true, () => false);

async function railwayProject(id: string): Promise<{ id: string; name: string; workspaceId: string } | null> {
  const r = await railwayApi<{ project: { id: string; name: string; workspaceId: string } | null }>(
    "query($id: String!) { project(id: $id) { id name workspaceId } }",
    { id },
  ).catch(() => ({ project: null }));
  return r.project;
}

if (command === "remove") {
  const state = JSON.parse(await readFile(stateFile, "utf8")) as State;
  if (state.marker !== MARKER || state.dir !== dir || !/^dfx-[0-9a-f]{8}$/.test(state.slug)) throw new Error("That folder is not a dashboard fixture. Nothing was removed.");
  if (state.appwriteProjectId) {
    const p = await admin.getProject(state.appwriteProjectId);
    if (p && p.name === `Dashboard fixture ${state.slug}`) await admin.deleteProject(state.appwriteProjectId);
    else if (p) console.warn(`Kept Appwrite project ${state.appwriteProjectId}: it does not look like this fixture.`);
  }
  if (state.railwayProjectId) {
    const p = await railwayProject(state.railwayProjectId);
    if (p && p.name === `${state.slug}-app` && p.workspaceId === state.workspaceId) {
      await railwayApi("mutation($id: String!) { projectDelete(id: $id) }", { id: state.railwayProjectId });
    } else if (p) console.warn(`Kept Railway project ${state.railwayProjectId}: it does not look like this fixture.`);
  }
  // Only what create made: the app copy, the registry and the state file, then the now-empty folder.
  await rm(join(dir, state.slug), { recursive: true, force: true });
  await unlink(join(dir, ".platform.json")).catch(() => {});
  await unlink(stateFile);
  await rmdir(dir).catch(() => console.warn(`Kept ${dir}: it has files the fixture did not make.`));
  console.log(`fixture ${state.slug} removed`);
  process.exit(0);
}

// --- create -------------------------------------------------------------------
if (await exists(dir)) throw new Error("Give a folder that does not exist yet; the fixture creates it.");
const slug = `dfx-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
await mkdir(dir, { recursive: true });
const state: State = { marker: MARKER, slug, dir, workspaceId: pins.workspaceId };
const record = (patch: Partial<State>) => writeFile(stateFile, `${JSON.stringify(Object.assign(state, patch), null, 2)}\n`);
await record({});
const folder = join(dir, slug);

// 1. Appwrite: project, a seeding key, the template's tables, test data.
if (await admin.getProject(slug)) throw new Error("A project with the random fixture name already exists. Run again.");
await admin.createProject(slug, `Dashboard fixture ${slug}`);
await record({ appwriteProjectId: slug });
const session = await consoleSession();
const seedScopes = ["users.read", "users.write", "databases.read", "databases.write", "tables.read", "tables.write", "columns.read", "columns.write", "indexes.read", "indexes.write", "rows.read", "rows.write", "buckets.read", "buckets.write", "files.read", "files.write"];
const seedKey = (await session.call<{ secret: string }>("POST", `/projects/${slug}/keys`, { keyId: "unique()", name: "fixture-online", scopes: seedScopes, expire: null })).secret;
await session.close();

await cp(join(import.meta.dir, "..", "..", "templates", "nextjs-appwrite"), folder, {
  recursive: true,
  filter: (src) => !/(node_modules|\.next|\.env\.local|\.mcp\.json)$/.test(src),
});
const env = { ...process.env, APPWRITE_ENDPOINT: config.endpoint, APPWRITE_PROJECT_ID: slug, APPWRITE_API_KEY: seedKey };
for (const step of [["bun", "install"], ["bun", "run", "setup"]]) {
  const proc = Bun.spawn(step, { cwd: folder, env, stdout: "ignore", stderr: "ignore" });
  if ((await proc.exited) !== 0) throw new Error(`${step.join(" ")} failed in the fixture.`);
}
const api = async (method: string, path: string, body?: unknown, form?: FormData) => {
  const res = await fetch(`${config.endpoint}${path}`, {
    method,
    headers: { "X-Appwrite-Project": slug, "X-Appwrite-Key": seedKey, ...(form ? {} : { "Content-Type": "application/json" }) },
    body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  if (!res.ok) throw new Error(`Fixture ${method} ${path.split("?")[0]} answered ${res.status}.`);
  return res.json();
};
await api("POST", "/users", { userId: "fixture-user-1", email: `${slug}-1@example.invalid`, name: "Fixture One", password: `Fixture-${crypto.randomUUID()}` });
await api("POST", "/users", { userId: "fixture-user-2", email: `${slug}-2@example.invalid`, name: "Fixture Two" });
for (const title of ["Buy milk", "Walk", "Fixture row"]) {
  await api("POST", "/tablesdb/main/tables/items/rows", { rowId: "unique()", data: { title, done: false }, permissions: ['read("user:fixture-user-1")'] });
}
await api("POST", "/storage/buckets", { bucketId: "uploads", name: "Uploads", permissions: [], fileSecurity: false });
for (const [name, bytes, type] of [
  ["data.json", new TextEncoder().encode('{"fixture":true,"note":"must come back byte for byte"}\n'), "application/json"],
  ["blob.bin", new Uint8Array([0, 255, 1, 254, 2, 253, 3]), "application/octet-stream"],
] as const) {
  const form = new FormData();
  form.set("fileId", "unique()");
  form.set("file", new Blob([bytes], { type }), name);
  await api("POST", "/storage/buckets/uploads/files", undefined, form);
}
console.log(`appwrite fixture ${slug} seeded`);

// 2. Railway: its own project in the pinned workspace, one web service, deployed by id.
const created = await railwayApi<{ projectCreate: { id: string; environments: { edges: { node: { id: string; name: string } }[] } } }>(
  "mutation($i: ProjectCreateInput!) { projectCreate(input: $i) { id environments { edges { node { id name } } } } }",
  { i: { name: `${slug}-app`, workspaceId: pins.workspaceId } },
);
const projectId = created.projectCreate.id;
await record({ railwayProjectId: projectId });
const environmentId = created.projectCreate.environments.edges.find((e) => e.node.name === "production")!.node.id;
const service = await railwayApi<{ serviceCreate: { id: string } }>("mutation($i: ServiceCreateInput!) { serviceCreate(input: $i) { id } }", { i: { projectId, name: "web" } });
const serviceId = service.serviceCreate.id;
await railwayApi("mutation($i: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $i) }", {
  i: { projectId, environmentId, serviceId, skipDeploys: true, variables: { APPWRITE_ENDPOINT: config.endpoint, APPWRITE_PROJECT_ID: slug, APPWRITE_API_KEY: seedKey, PORT: "3000", NEXT_TELEMETRY_DISABLED: "1" } },
});
await railwayApi("mutation($s: String!, $e: String!) { serviceInstanceUpdate(serviceId: $s, environmentId: $e, input: { sleepApplication: true }) }", { s: serviceId, e: environmentId });
const domain = await railwayApi<{ serviceDomainCreate: { domain: string } }>("mutation($i: ServiceDomainCreateInput!) { serviceDomainCreate(input: $i) { domain } }", { i: { serviceId, environmentId, targetPort: 3000 } });
for (const args of [["link", "--project", projectId, "--environment", environmentId, "--service", serviceId], ["up", folder, "--path-as-root", "--project", projectId, "--environment", environmentId, "--service", serviceId, "--detach"]]) {
  const proc = Bun.spawn(["railway", ...args], { cwd: folder, stdout: "ignore", stderr: "ignore" });
  if ((await proc.exited) !== 0) throw new Error(`railway ${args[0]} failed for the fixture.`);
}
console.log(`railway fixture deploying at https://${domain.serviceDomainCreate.domain}`);

// 3. A registry with only the fixture, for sync-dashboard's extra list.
await writeFile(join(dir, ".platform.json"), `${JSON.stringify({ apps: [{
  slug, name: `Fixture ${slug.slice(4)}`, projectId: slug, createdByPlatform: true, folder, port: 3199, repoUrl: null, git: "github", createdAt: new Date().toISOString(),
}] }, null, 2)}\n`);
console.log(JSON.stringify({ slug, name: `Fixture ${slug.slice(4)}`, url: `https://${domain.serviceDomainCreate.domain}`, registry: join(dir, ".platform.json") }));
