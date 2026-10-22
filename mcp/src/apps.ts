import { cp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { AppwriteAdmin, AppwriteError } from "./appwrite-admin";
import { config } from "./config";
import { run, succeeds } from "./exec";
import { createPrivateRepo } from "./github";
import { type AppRecord, loadRegistry, nextFreePort, removeApp, upsertApp } from "./registry";
import { toSlug } from "./slug";

// Every step checks whether its result already exists, so calling create_app
// again after a failure resumes where it stopped instead of duplicating.

const admin = new AppwriteAdmin();

const SKIP_IN_TEMPLATE = new Set(["node_modules", ".next", "next-env.d.ts", "tsconfig.tsbuildinfo", ".env.local", ".mcp.json"]);

export type CreateAppInput = {
  name: string;
  /** Only when Appwrite cannot create projects itself: an existing project id and server key. */
  projectId?: string;
  apiKey?: string;
};

export type CreateAppResult = AppRecord & { localUrl: string; steps: string[]; next: string[] };

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

async function readEnv(file: string): Promise<Record<string, string>> {
  if (!(await exists(file))) return {};
  const lines = (await readFile(file, "utf8")).split("\n");
  return Object.fromEntries(
    lines.filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

async function writeEnv(file: string, values: Record<string, string>): Promise<void> {
  const body = Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  await writeFile(file, `# Written by the platform's create_app tool. Never commit this file.\n${body}\n`, { mode: 0o600 });
}

async function copyTemplate(folder: string, slug: string, port: number): Promise<void> {
  await cp(config.templateDir, folder, {
    recursive: true,
    filter: (src) => !SKIP_IN_TEMPLATE.has(basename(src)),
  });
  const pkgFile = join(folder, "package.json");
  const pkg = JSON.parse(await readFile(pkgFile, "utf8"));
  pkg.name = slug;
  pkg.scripts.dev = `next dev -p ${port}`;
  pkg.scripts.start = `next start -p ${port}`;
  await writeFile(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
}

async function ensurePlatform(projectId: string, hostname: string): Promise<void> {
  try {
    await admin.addWebPlatform(projectId, hostname);
  } catch (error) {
    if (error instanceof AppwriteError && error.status === 409) return;
    throw error;
  }
}

async function writeMcpConfig(folder: string, env: Record<string, string>): Promise<void> {
  const mcp = {
    mcpServers: {
      appwrite: {
        command: "uvx",
        args: ["mcp-server-appwrite"],
        env: {
          APPWRITE_ENDPOINT: env.APPWRITE_ENDPOINT,
          APPWRITE_PROJECT_ID: env.APPWRITE_PROJECT_ID,
          APPWRITE_API_KEY: env.APPWRITE_API_KEY,
        },
      },
    },
  };
  await writeFile(join(folder, ".mcp.json"), `${JSON.stringify(mcp, null, 2)}\n`, { mode: 0o600 });
}

export async function createApp(input: CreateAppInput): Promise<CreateAppResult> {
  const slug = toSlug(input.name);
  const steps: string[] = [];
  if (!(await admin.health())) {
    throw new Error(`Appwrite is not reachable at ${config.endpoint}. Start it: cd infra/appwrite && docker compose up -d`);
  }

  const registry = await loadRegistry();
  const known = registry.apps.find((a) => a.slug === slug);
  const port = known?.port ?? nextFreePort(registry.apps);
  const folder = known?.folder ?? join(config.appsDir, slug);
  const projectId = input.projectId ?? known?.projectId ?? slug;

  if (input.projectId) {
    steps.push(`using existing project ${projectId}`);
  } else if (await admin.getProject(projectId)) {
    steps.push(`project ${projectId} already exists`);
  } else {
    await admin.createProject(projectId, input.name);
    steps.push(`created project ${projectId}`);
  }

  if (await exists(folder)) {
    steps.push(`folder exists: ${folder}`);
  } else {
    await copyTemplate(folder, slug, port);
    steps.push(`copied starter kit to ${folder}`);
  }

  const envFile = join(folder, ".env.local");
  const env = await readEnv(envFile);
  if (!env.APPWRITE_API_KEY) {
    const key = input.apiKey ?? (await admin.createServerKey(projectId, `${slug}-server`)).secret;
    Object.assign(env, { APPWRITE_ENDPOINT: config.endpoint, APPWRITE_PROJECT_ID: projectId, APPWRITE_API_KEY: key, PORT: String(port) });
    await writeEnv(envFile, env);
    steps.push(input.apiKey ? "saved the given server key" : "created a server key");
  }
  await writeMcpConfig(folder, env);

  if (!input.projectId) {
    await ensurePlatform(projectId, "localhost");
    steps.push("allowed localhost as web platform");
  }

  await run(["bun", "install"], folder);
  await run(["bun", "run", "setup"], folder);
  steps.push("installed packages and created tables");

  let repoUrl = known?.repoUrl ?? null;
  try {
    repoUrl = await createPrivateRepo(folder, slug);
    steps.push(`private repo ${repoUrl}`);
  } catch (error) {
    steps.push(`GitHub repo not created: ${(error as Error).message}. Rerun create_app to retry.`);
  }

  const record: AppRecord = {
    slug,
    name: input.name,
    projectId,
    folder,
    port,
    repoUrl,
    createdAt: known?.createdAt ?? new Date().toISOString(),
  };
  await upsertApp(record);

  return {
    ...record,
    localUrl: `http://localhost:${port}`,
    steps,
    next: [`cd ${folder}`, "bun run dev", `open http://localhost:${port}`, "Read CLAUDE.md in the app folder before building features."],
  };
}

export async function listApps(): Promise<AppRecord[]> {
  return (await loadRegistry()).apps;
}

export type DeleteResult = { slug: string; projectDeleted: boolean; folderDeleted: boolean; notes: string[] };

/** Deletes the Appwrite project (users and data). The GitHub repo is never touched. */
export async function deleteApp(slug: string, confirm: string): Promise<DeleteResult> {
  if (confirm !== slug) throw new Error(`To delete, pass confirm equal to the app id "${slug}".`);
  const app = (await loadRegistry()).apps.find((a) => a.slug === slug);
  if (!app) throw new Error(`No app called "${slug}".`);
  const notes: string[] = [];

  let projectDeleted = false;
  if (await admin.getProject(app.projectId)) {
    await admin.deleteProject(app.projectId);
    projectDeleted = true;
  }

  // Remove the folder only when nothing in it would be lost.
  let folderDeleted = false;
  if (await exists(app.folder)) {
    const clean = (await succeeds(["git", "diff", "--quiet", "HEAD"], app.folder)) &&
      (await run(["git", "status", "--porcelain"], app.folder).catch(() => "dirty")) === "";
    const pushed = await run(["git", "rev-list", "@{u}..HEAD", "--count"], app.folder).then(
      (n) => n === "0",
      () => false,
    );
    if (clean && pushed && app.repoUrl) {
      await rm(app.folder, { recursive: true, force: true });
      folderDeleted = true;
    } else {
      notes.push(`Kept ${app.folder}: it has uncommitted or unpushed work.`);
    }
  }
  if (app.repoUrl) notes.push(`The GitHub repo ${app.repoUrl} was kept.`);

  await removeApp(slug);
  return { slug, projectDeleted, folderDeleted, notes };
}
