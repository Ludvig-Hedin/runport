import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("deploy uploads only a published commit to the named production service", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runport-deploy-test-"));
  const env = { ...process.env, PATH: `${cwd}/bin:${process.env.PATH}`, FIXTURE: cwd };
  const run = (...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env });
  const git = (...args: string[]) => {
    const result = run("git", ...args);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  const deploy = (...args: string[]) => run("bash", "infra/railway/apply.sh", ...args);
  try {
    for (const directory of ["bin", "infra/railway/ops", "infra/railway/router", "infra/railway/git", "infra/railway/analytics", "infra/mail-gateway", "infra/railway/mail-storage"]) {
      mkdirSync(join(cwd, directory), { recursive: true });
    }
    for (const file of ["apply.sh", "check-mail-storage.ts", "mail-storage-state.graphql"]) {
      copyFileSync(new URL(`../${file}`, import.meta.url), join(cwd, "infra/railway", file));
    }
    writeFileSync(join(cwd, "infra/railway/ops/source.txt"), "committed-ops\n");
    writeFileSync(join(cwd, "infra/railway/router/source.txt"), "committed-router\n");
    writeFileSync(join(cwd, "infra/railway/git/source.txt"), "committed-git\n");
    writeFileSync(join(cwd, "infra/railway/analytics/source.txt"), "committed-analytics\n");
    writeFileSync(join(cwd, "infra/mail-gateway/source.txt"), "committed-gateway\n");
    writeFileSync(join(cwd, "infra/railway/mail-storage/source.txt"), "committed-maintenance\n");
    writeFileSync(join(cwd, "bin/gh"), `#!/bin/bash
set -eu
test "$*" = "api --hostname github.com repos/Ludvig-Hedin/runport/git/ref/heads/main --jq .object.sha"
cat "$FIXTURE/canonical-main"
`, { mode: 0o700 });
    writeFileSync(join(cwd, "bin/railway"), `#!/bin/bash
set -eu
case "$1" in
  api) cat "$FIXTURE/railway-storage"; exit ;;
  ssh) test -f "$FIXTURE/storage-ready"; exit ;;
esac
test "$1" = up
test ! -e "$2/untracked.txt"
bun -e 'import { statSync } from "node:fs"; if (!(statSync(process.argv[1]).mode & 4)) process.exit(1);' "$2/source.txt"
cat "$2/source.txt"
printf '%s\\n' "${"$"}{@:3}"
`, { mode: 0o700 });
    git("init", "-b", "main");
    git("add", "infra");
    const commitArgs = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit"];
    git(...commitArgs, "-m", "published");
    const published = git("rev-parse", "HEAD");
    writeFileSync(join(cwd, "canonical-main"), published);
    git("remote", "add", "origin", cwd);
    writeFileSync(join(cwd, "infra/mail-gateway/source.txt"), "dirty\n");
    writeFileSync(join(cwd, "infra/mail-gateway/untracked.txt"), "untracked\n");
    const setStorage = (attached: boolean, stopped: boolean) => {
      const gateway = "8c4bedd8-5d19-42e7-8f05-3289f4f8dff0";
      const connection = (node: unknown) => ({ edges: [{ node }], pageInfo: { hasNextPage: false } });
      writeFileSync(join(cwd, "railway-storage"), JSON.stringify({ data: { environment: {
        id: "d95ac74a-26dc-4738-8765-3ab1389e057f",
        volumeInstances: connection({
          id: "744eff6f-4274-4170-81e7-b920a773870d", state: "READY",
          serviceId: attached ? gateway : null, mountPath: attached ? "/data" : "/tmp", volume: { name: "mail-gateway-data" },
        }),
        serviceInstances: connection({
          serviceId: gateway, latestDeployment: { deploymentStopped: stopped },
          activeDeployments: stopped ? [] : [{ deploymentStopped: false }],
        }),
      } } }));
    };
    setStorage(false, true);
    expect(deploy("deploy-gateway").exitCode).toBe(1);
    expect(deploy("prepare-gateway-storage").exitCode).toBe(1);
    const snapshot = join(cwd, "cutover.sqlite");
    const quota = new Database(snapshot);
    quota.run("CREATE TABLE sent_by_kind (day TEXT, app TEXT, kind TEXT, recipients INTEGER)");
    quota.close();
    utimesSync(snapshot, 1, 1);
    const bootstrap = deploy("bootstrap-gateway-storage", snapshot);
    expect(bootstrap.exitCode).toBe(0);
    expect(bootstrap.stdout.toString()).toContain(`Runport bootstrap mail-gateway ${published}`);
    setStorage(true, false);
    expect(deploy("deploy-gateway").exitCode).toBe(1);
    expect(deploy("prepare-gateway-storage").exitCode).toBe(1);
    expect(deploy("bootstrap-gateway-storage", snapshot).exitCode).toBe(1);
    setStorage(true, true);
    writeFileSync(join(cwd, "storage-ready"), "");

    for (const [command, service, source] of [
      ["deploy-gateway", "mail-gateway", "gateway"],
      ["prepare-gateway-storage", "mail-gateway", "maintenance"],
      ["deploy-router", "router", "router"],
      ["deploy-git", "git", "git"],
      ["deploy-analytics", "analytics", "analytics"],
      ["deploy-monitor", "monitor", "ops"],
      ["deploy-backup", "backup", "ops"],
    ]) {
      const result = deploy(command);
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      expect(result.stdout.toString().trim().split("\n")).toEqual([
        `committed-${source}`, "--path-as-root", "--detach", "--message",
        `Runport ${service} ${published}`, "--project", "c93df5f9-ac8b-453d-815a-e9fedd991ca1",
        "--environment", "d95ac74a-26dc-4738-8765-3ab1389e057f", "--service", service,
      ]);
    }
    expect(deploy("deploy-gateway", "--service", "git").exitCode).toBe(64);
    git("switch", "-c", "unpublished");
    git(...commitArgs, "--allow-empty", "-m", "unpublished");
    git("branch", "-f", "main", "HEAD");
    for (const origin of [cwd, "https://github.com/fixture/runport-fork", "https://mirror.example.invalid/runport"]) {
      git("remote", "set-url", "origin", origin);
      expect(deploy("deploy-gateway").exitCode).toBe(1);
    }
    git("switch", "--detach", published);
    appendFileSync(join(cwd, "infra/railway/apply.sh"), "\n# local change\n");
    expect(deploy("deploy-gateway").exitCode).toBe(1);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});
