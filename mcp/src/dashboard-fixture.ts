// A throwaway app for testing the dashboard's pause, resume and delete on
// real services, never on a real app. It gets its own Appwrite project and
// its own Railway project "<slug>-app", seeded with two test users (one with
// a password), three rows, a JSON file and a binary file. No email is sent:
// users are made with the server key on example.invalid addresses.
//
//   bun src/dashboard-fixture.ts create <dir>   makes it, writes <dir>/.platform.json
//   bun src/dashboard-fixture.ts remove <dir>   removes whatever is left of it
// Run with PLATFORM_KEYCHAIN_SERVICE=runport-prod PLATFORM_APPWRITE_ENDPOINT=https://admin.runport.app/v1.
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AppwriteAdmin } from "./appwrite-admin";
import { config } from "./config";
import { railwayApi } from "./railway-api";
import { consoleSession } from "./sync-dashboard";

const SLUG = "dash-fixture";
const [command, dirArg] = process.argv.slice(2);
if (!dirArg || (command !== "create" && command !== "remove")) throw new Error("Usage: bun src/dashboard-fixture.ts create|remove <dir>");
const dir = resolve(dirArg);
const folder = join(dir, SLUG);
const admin = new AppwriteAdmin();
const workspaceId = (await railwayApi<{ me: { workspaces: { id: string }[] } }>("{ me { workspaces { id } } }", {})).me.workspaces[0]!.id;

async function findRailway(): Promise<string | null> {
  const list = await railwayApi<{ workspace: { projects: { edges: { node: { id: string; name: string } }[] } } }>(
    "query($w: String!) { workspace(workspaceId: $w) { projects { edges { node { id name } } } } }",
    { w: workspaceId },
  );
  return list.workspace.projects.edges.find((e) => e.node.name === `${SLUG}-app`)?.node.id ?? null;
}

if (command === "remove") {
  if (await admin.getProject(SLUG)) await admin.deleteProject(SLUG);
  const id = await findRailway();
  if (id) await railwayApi("mutation($id: String!) { projectDelete(id: $id) }", { id });
  await rm(dir, { recursive: true, force: true });
  console.log("fixture removed");
  process.exit(0);
}

// 1. Appwrite: project, a full key for seeding, the template's tables, data.
if (await admin.getProject(SLUG)) throw new Error("A fixture already exists. Remove it first.");
await admin.createProject(SLUG, "Dashboard fixture");
const session = await consoleSession();
const seedScopes = ["users.read", "users.write", "databases.read", "databases.write", "tables.read", "tables.write", "columns.read", "columns.write", "indexes.read", "indexes.write", "rows.read", "rows.write", "buckets.read", "buckets.write", "files.read", "files.write"];
const seedKey = (await session.call<{ secret: string }>("POST", `/projects/${SLUG}/keys`, { keyId: "unique()", name: "fixture-seed", scopes: seedScopes, expire: null })).secret;
await session.close();

await mkdir(dir, { recursive: true });
await cp(join(import.meta.dir, "..", "..", "templates", "nextjs-appwrite"), folder, {
  recursive: true,
  filter: (src) => !/(node_modules|\.next|\.env\.local|\.mcp\.json)$/.test(src),
});
const env = { ...process.env, APPWRITE_ENDPOINT: config.endpoint, APPWRITE_PROJECT_ID: SLUG, APPWRITE_API_KEY: seedKey };
for (const step of [["bun", "install"], ["bun", "run", "setup"]]) {
  const proc = Bun.spawn(step, { cwd: folder, env, stdout: "ignore", stderr: "ignore" });
  if ((await proc.exited) !== 0) throw new Error(`${step.join(" ")} failed in the fixture.`);
}
const api = async (method: string, path: string, body?: unknown, form?: FormData) => {
  const res = await fetch(`${config.endpoint}${path}`, {
    method,
    headers: { "X-Appwrite-Project": SLUG, "X-Appwrite-Key": seedKey, ...(form ? {} : { "Content-Type": "application/json" }) },
    body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  if (!res.ok) throw new Error(`Fixture ${method} ${path} answered ${res.status}.`);
  return res.json();
};
await api("POST", "/users", { userId: "fixture-user-1", email: "fixture-1@example.invalid", name: "Fixture One", password: `Fixture-${crypto.randomUUID()}` });
await api("POST", "/users", { userId: "fixture-user-2", email: "fixture-2@example.invalid", name: "Fixture Two" });
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
console.log("appwrite fixture seeded");

// 2. Railway: its own project with one web service, deployed by id.
const created = await railwayApi<{ projectCreate: { id: string; environments: { edges: { node: { id: string; name: string } }[] } } }>(
  "mutation($i: ProjectCreateInput!) { projectCreate(input: $i) { id environments { edges { node { id name } } } } }",
  { i: { name: `${SLUG}-app`, workspaceId } },
);
const projectId = created.projectCreate.id;
const environmentId = created.projectCreate.environments.edges.find((e) => e.node.name === "production")!.node.id;
const service = await railwayApi<{ serviceCreate: { id: string } }>("mutation($i: ServiceCreateInput!) { serviceCreate(input: $i) { id } }", { i: { projectId, name: "web" } });
const serviceId = service.serviceCreate.id;
await railwayApi("mutation($i: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $i) }", {
  i: { projectId, environmentId, serviceId, skipDeploys: true, variables: { APPWRITE_ENDPOINT: config.endpoint, APPWRITE_PROJECT_ID: SLUG, APPWRITE_API_KEY: seedKey, PORT: "3000", NEXT_TELEMETRY_DISABLED: "1" } },
});
await railwayApi("mutation($s: String!, $e: String!) { serviceInstanceUpdate(serviceId: $s, environmentId: $e, input: { sleepApplication: true }) }", { s: serviceId, e: environmentId });
await railwayApi("mutation($i: ServiceDomainCreateInput!) { serviceDomainCreate(input: $i) { domain } }", { i: { serviceId, environmentId, targetPort: 3000 } });
for (const args of [["link", "--project", projectId, "--environment", environmentId, "--service", serviceId], ["up", folder, "--path-as-root", "--project", projectId, "--environment", environmentId, "--service", serviceId, "--detach"]]) {
  const proc = Bun.spawn(["railway", ...args], { cwd: folder, stdout: "ignore", stderr: "ignore" });
  if ((await proc.exited) !== 0) throw new Error(`railway ${args[0]} failed for the fixture.`);
}
console.log("railway fixture deploying");

// 3. A registry with only the fixture, for sync-dashboard's extra list.
await writeFile(join(dir, ".platform.json"), `${JSON.stringify({ apps: [{
  slug: SLUG, name: "Dashboard fixture", projectId: SLUG, createdByPlatform: true, folder, port: 3199, repoUrl: null, git: "github", createdAt: new Date().toISOString(),
}] }, null, 2)}\n`);
console.log(`registry: ${join(dir, ".platform.json")}`);
