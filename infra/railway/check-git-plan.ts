const serviceKinds = new Set(["resource.create", "resource.update", "field.set", "variable.set"]);
const opsVariables = new Map([
  ["service.backup", new Set(["GIT_BACKUP_URL", "GIT_BACKUP_TOKEN"])],
  ["service.monitor", new Set(["GIT_HEALTH_URL"])],
]);

export function assertAnalyticsPlan(plan: unknown, requireNoop = false): void {
  if (!plan || typeof plan !== "object") throw new Error("Unrecognized Railway plan.");
  const { kind, version, destructive, claim, changeSet } = plan as {
    kind?: unknown; version?: unknown; destructive?: unknown; claim?: unknown; changeSet?: { changes?: unknown };
  };
  if (kind !== "railway.config.plan" || version !== 1 || destructive !== false ||
      (claim !== undefined && claim !== false) || !Array.isArray(changeSet?.changes)) {
    throw new Error("Analytics plan is destructive, claims resources, or uses an unrecognized format.");
  }
  if (requireNoop && changeSet.changes.length) throw new Error("Railway plan contains changes. No-op apply refused.");
  for (const change of changeSet.changes) {
    const { kind, address, severity, path, variable, field, before, after, details } = change ?? {};
    const analytics = address === "service.analytics";
    const isVariable = kind === "variable.set" && path === `resources.${address}.variables.${variable}` &&
      ((analytics && variable === "ANALYTICS_INGEST_SECRET") ||
       (address === "service.monitor" && variable === "ANALYTICS_HEALTH_URL"));
    const isSource = analytics && kind === "resource.update" && field === "source" &&
      path === "resources.service.analytics.source" && after === null &&
      before?.type === "image" && before?.image === "ghcr.io/umami-software/umami:3.5.0";
    const isHealth = analytics && kind === "resource.update" && field === "deploy" &&
      path === "resources.service.analytics.deploy" && before?.healthcheckPath === "/api/heartbeat" &&
      after?.healthcheckPath === "/runport/health" && Object.keys(after).length === 2 &&
      Object.hasOwn(after, "multiRegionConfig") &&
      JSON.stringify(after.multiRegionConfig) === JSON.stringify(before.multiRegionConfig) &&
      Array.isArray(details) && details.length === 1 &&
      details[0] === 'deploy.healthcheckPath ("/api/heartbeat" → "/runport/health")';
    if (severity !== "safe" || !(isVariable || isSource || isHealth)) {
      throw new Error("Railway plan includes a change outside the analytics cutover allowlist.");
    }
  }
}

export function assertGitPlan(plan: unknown, requireNoop = false): void {
  if (!plan || typeof plan !== "object") throw new Error("Unrecognized Railway plan.");
  const { kind, version, destructive, claim, changeSet } = plan as {
    kind?: unknown; version?: unknown; destructive?: unknown; claim?: unknown; changeSet?: { changes?: unknown };
  };
  if (kind !== "railway.config.plan" || version !== 1 || destructive !== false || !Array.isArray(changeSet?.changes)) {
    throw new Error("Railway plan is destructive or uses an unrecognized format.");
  }
  if (claim !== undefined && claim !== false && (claim !== true || changeSet.changes.length)) {
    throw new Error("Git apply cannot claim Railway resources while making changes.");
  }
  if (requireNoop && changeSet.changes.length) throw new Error("Railway plan contains changes. No-op apply refused.");
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
    const path = process.argv[2] ?? "";
    const plan = await Bun.file(path).json();
    const flags = process.argv.slice(3);
    if (flags.includes("--analytics")) {
      // Apply the pinned change set and leave whole-project ownership alone.
      assertAnalyticsPlan({ ...plan, claim: plan.claim === true ? false : plan.claim }, flags.includes("--no-op"));
    } else {
      assertGitPlan(plan, flags.includes("--no-op"));
    }
    // Railway can flag an empty whole-project plan to claim resources.
    // Disable that metadata-only operation. The CLI still validates the
    // original change-set hash, source hash and environment ETag.
    if (plan.claim === true) {
      plan.claim = false;
      await Bun.write(path, JSON.stringify(plan));
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
