import { expect, test } from "bun:test";
import { assertGitPlan } from "../check-git-plan";
import { expiredArchives, finishArchive } from "../ops/retention";

const plan = (changes: object[], destructive = false) => ({
  kind: "railway.config.plan", version: 1, destructive, changeSet: { changes },
});
const change = (address: string, kind: string, variable?: string) => ({
  address, kind, severity: "safe",
  path: `resources.${address}${variable ? ".variables." + variable : ""}`, variable,
});

test("Git apply permits its own resources and only the Git job variables", () => {
  expect(() => assertGitPlan(plan([]))).not.toThrow();
  expect(() => assertGitPlan(plan([
    change("service.git", "resource.create"),
    change("volume.git-data", "resource.create"),
    change("service.backup", "variable.set", "GIT_BACKUP_TOKEN"),
    change("service.monitor", "variable.set", "GIT_HEALTH_URL"),
  ]))).not.toThrow();
  for (const blocked of [
    change("service.analytics", "resource.update"), change("service.git", "resource.delete"),
    change("service.backup", "variable.set", "ANALYTICS_DATABASE"), change("service.monitor", "resource.update"),
    change("service.appwrite", "resource.update"), change("volume.git-data", "resource.delete"),
  ]) {
    expect(() => assertGitPlan(plan([blocked]))).toThrow();
  }
  expect(() => assertGitPlan(plan([], true))).toThrow();
  expect(() => assertGitPlan({ changes: [] })).toThrow();
});

test("a failed upload skips only its own prune", async () => {
  const pruned: string[] = [];
  const results = await Promise.allSettled(["appwrite", "git", "analytics"].map((kind) =>
    finishArchive(async () => {
      if (kind === "git") throw new Error("fixture upload failure");
    }, async () => { pruned.push(kind); }),
  ));
  expect(pruned.sort()).toEqual(["analytics", "appwrite"]);
  expect(results.map(({ status }) => status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
});

test("pruning keeps the newest archive in each prefix and ignores other files", () => {
  const keys = [
    "backups/appwrite-2026-10-01.dump", "backups/appwrite-2026-10-02.dump",
    "backups/analytics-2026-10-01.dump", "backups/analytics-2026-10-02.dump",
    "backups/git-2026-10-01.tar.gz", "backups/git-2026-10-02.tar.gz",
    "backups/git-2026-10-01.tar.gz.tmp", "backups/git-2026-10-03.dump",
  ];
  const cutoff = Date.parse("2026-11-01");
  expect(expiredArchives(keys, "git", cutoff, "")).toEqual(["backups/git-2026-10-01.tar.gz"]);
  expect(expiredArchives(keys, "appwrite", cutoff, "")).toEqual(["backups/appwrite-2026-10-01.dump"]);
  expect(expiredArchives(keys, "analytics", cutoff, "")).toEqual(["backups/analytics-2026-10-01.dump"]);
  expect(expiredArchives(keys, "git", cutoff, "backups/git-2026-10-01.tar.gz")).toEqual([]);
});
