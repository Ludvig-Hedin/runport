import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGitHost, selectGitHost } from "../src/git-host";
import { loadRegistry } from "../src/registry";
import { ensureStarterPush, provisioningCredentials } from "../src/runport-git";
import { run } from "../src/exec";

test("new apps use Runport by default or GitHub when requested", () => {
  expect(parseGitHost.parse(undefined)).toBeUndefined();
  expect(selectGitHost()).toBe("runport");
  expect(selectGitHost(parseGitHost.parse("github"))).toBe("github");
  expect(selectGitHost(parseGitHost.parse("runport"))).toBe("runport");
  expect(parseGitHost.safeParse("somewhere-else").success).toBe(false);
});

test("retries reuse the registered host and refuse to replace it", () => {
  expect(selectGitHost(undefined, "github")).toBe("github");
  expect(selectGitHost("runport", "runport")).toBe("runport");
  expect(() => selectGitHost("runport", "github")).toThrow("github");
});

test("registry reads legacy GitHub records and preserves explicit hosts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runport-registry-"));
  try {
    const file = join(dir, "registry.json");
    const app = {
      slug: "legacy", name: "Legacy", projectId: "legacy", createdByPlatform: true,
      folder: join(dir, "legacy"), port: 3101, repoUrl: "https://github.com/example/legacy",
      createdAt: "2026-10-25T00:00:00Z",
    };
    const runport = { ...app, slug: "new", git: "runport" as const, repoUrl: null };
    await writeFile(file, JSON.stringify({ apps: [app, runport] }));
    expect((await loadRegistry(file)).apps).toEqual([{ ...app, git: "github" }, runport]);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("a package install failure preserves the GitHub choice on retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runport-create-retry-"));
  try {
    const script = `
      import { createApp } from ${JSON.stringify(join(import.meta.dir, "../src/apps.ts"))};
      globalThis.fetch = async (url) => {
        if (String(url) !== "http://fixture.invalid/v1/health/version") throw Error("Unexpected network request");
        return new Response(null, { status: 200 });
      };
      Bun.spawn = (args, options) => {
        if (args.join(" ") !== "bun install" || options.cwd !== process.env.PLATFORM_APPS_DIR + "/retry-app") {
          throw Error("Unexpected command");
        }
        return { stdout: new Blob().stream(), stderr: new Blob(["fixture install failure"]).stream(), exited: Promise.resolve(1) };
      };
      const app = { name: "Retry App", projectId: "fixture", apiKey: "fixture" };
      for (const input of [{ ...app, git: "github" }, app]) {
        try {
          await createApp(input);
          throw Error("Expected install to fail");
        } catch (error) {
          if (!String(error).includes("fixture install failure")) throw error;
        }
        const { apps } = await Bun.file(process.env.PLATFORM_APPS_DIR + "/.platform.json").json();
        if (apps[0]?.git !== "github") throw Error("GitHub choice lost");
      }
    `;
    const proc = Bun.spawn([process.execPath, "-e", script], {
      env: { ...process.env, PLATFORM_APPS_DIR: dir, PLATFORM_APPWRITE_ENDPOINT: "http://fixture.invalid/v1" },
      stdout: "ignore", stderr: "pipe",
    });
    const err = await new Response(proc.stderr).text();
    expect({ code: await proc.exited, err }).toEqual({ code: 0, err: "" });
  } finally {
    await rm(dir, { recursive: true });
  }
});

test.each(["master", "main"])("pushes the checked-out %s branch to the real remote main", async (branch) => {
  const root = await mkdtemp(join(tmpdir(), "runport-git-starter-"));
  try {
    const local = join(root, "local");
    const origin = join(root, "origin.git");
    const elsewhere = join(root, "elsewhere.git");
    await mkdir(local);
    await run(["git", "init", "--quiet", "--initial-branch", branch, local]);
    await run(["git", "init", "--quiet", "--bare", origin]);
    await run(["git", "init", "--quiet", "--bare", elsewhere]);
    const git = (...args: string[]) => run(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], local);
    await git("remote", "add", "origin", origin);
    await git("remote", "add", "elsewhere", elsewhere);
    await git("commit", "--quiet", "--allow-empty", "-m", "Starter");
    if (branch === "main") {
      await git("push", "origin", "HEAD:refs/heads/main");
      await git("config", "remote.elsewhere.fetch", "+refs/heads/feature:refs/remotes/origin/main");
      await git("push", "elsewhere", "HEAD:refs/heads/feature");
      await git("fetch", "elsewhere");
      await git("config", "branch.main.remote", "elsewhere");
      await git("config", "branch.main.merge", "refs/heads/feature");
      expect(await git("rev-parse", "--symbolic-full-name", "@{u}")).toBe("refs/remotes/origin/main");
      await git("commit", "--quiet", "--allow-empty", "-m", "Local change");
    }
    await ensureStarterPush(local, origin);
    const head = await git("rev-parse", "HEAD");
    expect(await git("ls-remote", "--refs", origin, "refs/heads/main")).toBe(`${head}\trefs/heads/main`);
    expect(await git("config", `branch.${branch}.remote`)).toBe("origin");
    expect(await git("config", `branch.${branch}.merge`)).toBe("refs/heads/main");
    await git("commit", "--quiet", "--allow-empty", "-m", "Keep this change local on retry");
    await ensureStarterPush(local, origin);
    expect(await git("ls-remote", "--refs", origin, "refs/heads/main")).toBe(`${head}\trefs/heads/main`);
  } finally {
    await rm(root, { recursive: true });
  }
});

test("a custom Git origin requires its own explicitly configured Keychain credentials", () => {
  expect(provisioningCredentials("https://git.runport.app").service).toBe("runport-prod");
  expect(() => provisioningCredentials("https://git.example.test")).toThrow("PLATFORM_GIT_KEYCHAIN_SERVICE");
  expect(provisioningCredentials("https://git.example.test", "testing").tokenAccount)
    .toBe("git-provision-token@https://git.example.test");
  expect(() => provisioningCredentials("https://git.runport.app@elsewhere.test", "testing")).toThrow("HTTPS origin");
});
