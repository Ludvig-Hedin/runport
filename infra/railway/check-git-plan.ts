const serviceKinds = new Set(["resource.create", "resource.update", "field.set", "variable.set"]);
const opsVariables = new Map([
  ["service.backup", new Set(["GIT_BACKUP_URL", "GIT_BACKUP_TOKEN"])],
  ["service.monitor", new Set(["GIT_HEALTH_URL"])],
]);

export function assertGitPlan(plan: unknown): void {
  if (!plan || typeof plan !== "object") throw new Error("Unrecognized Railway plan.");
  const { kind, version, destructive, changeSet } = plan as {
    kind?: unknown; version?: unknown; destructive?: unknown; changeSet?: { changes?: unknown };
  };
  if (kind !== "railway.config.plan" || version !== 1 || destructive !== false || !Array.isArray(changeSet?.changes)) {
    throw new Error("Railway plan is destructive or uses an unrecognized format.");
  }
  for (const change of changeSet.changes) {
    const { kind, address, severity, path, variable } = change ?? {};
    const resourcePath = `resources.${address}`;
    if (severity !== "safe") throw new Error("Railway plan contains a change not marked safe.");
    const allowed = (address === "service.git" && serviceKinds.has(kind) &&
      (path === resourcePath || path?.startsWith(resourcePath + "."))) ||
      (address === "volume.git-data" && kind === "resource.create" && path === resourcePath) ||
      (kind === "variable.set" && opsVariables.get(address)?.has(variable) &&
        path === `${resourcePath}.variables.${variable}`);
    if (!allowed) throw new Error("Railway plan includes a change outside the Git apply allowlist.");
  }
}

if (import.meta.main) {
  try {
    const plan = await Bun.file(process.argv[2] ?? "").json();
    assertGitPlan(plan);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
