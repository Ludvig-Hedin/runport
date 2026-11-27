import { expect, test } from "bun:test";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("deploy uploads only a published commit to the named production service", () => {
  const cwd = mkdtempSync(join(tmpdir(), "runport-deploy-test-"));
  const env = { ...process.env, PATH: `${cwd}/bin:${process.env.PATH}` };
  const run = (...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env });
  const git = (...args: string[]) => {
    const result = run("git", ...args);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  const deploy = (...args: string[]) => run("bash", "infra/railway/apply.sh", ...args);
  try {
    for (const directory of ["bin", "infra/railway/ops", "infra/railway/router", "infra/mail-gateway"]) {
      mkdirSync(join(cwd, directory), { recursive: true });
    }
    copyFileSync(new URL("../apply.sh", import.meta.url), join(cwd, "infra/railway/apply.sh"));
    writeFileSync(join(cwd, "infra/railway/ops/source.txt"), "committed-ops\n");
    writeFileSync(join(cwd, "infra/railway/router/source.txt"), "committed-router\n");
    writeFileSync(join(cwd, "infra/mail-gateway/source.txt"), "committed-gateway\n");
    writeFileSync(join(cwd, "bin/railway"), `#!/bin/bash
set -eu
test "$1" = up
test ! -e "$2/untracked.txt"
cat "$2/source.txt"
printf '%s\\n' "${"$"}{@:3}"
`, { mode: 0o700 });
    git("init", "-b", "main");
    git("add", "infra");
    const commitArgs = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit"];
    git(...commitArgs, "-m", "published");
    const published = git("rev-parse", "HEAD");
    git("remote", "add", "origin", cwd);
    writeFileSync(join(cwd, "infra/mail-gateway/source.txt"), "dirty\n");
    writeFileSync(join(cwd, "infra/mail-gateway/untracked.txt"), "untracked\n");

    for (const [command, service, source] of [
      ["deploy-gateway", "mail-gateway", "gateway"],
      ["deploy-router", "router", "router"],
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
    expect(deploy("deploy-gateway").exitCode).toBe(1);
    git("switch", "main");
    appendFileSync(join(cwd, "infra/railway/apply.sh"), "\n# local change\n");
    expect(deploy("deploy-gateway").exitCode).toBe(1);
  } finally {
    rmSync(cwd, { force: true, recursive: true });
  }
});
