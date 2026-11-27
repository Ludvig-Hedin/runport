import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGitHost, selectGitHost } from "../src/git-host";
import { loadRegistry } from "../src/registry";

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
