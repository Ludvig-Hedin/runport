import { expect, test } from "bun:test";
import { assertAnalyticsPlan, assertGitPlan } from "../check-git-plan";

const plan = (changes: object[]) => ({
  kind: "railway.config.plan", version: 1, destructive: false, claim: false, changeSet: { changes },
});
const variable = (address: string, name: string) => ({
  address, kind: "variable.set", severity: "safe", variable: name, path: `resources.${address}.variables.${name}`,
});
const source = {
  address: "service.analytics", kind: "resource.update", severity: "safe", field: "source",
  path: "resources.service.analytics.source", before: { type: "image", image: "ghcr.io/umami-software/umami:3.5.0" }, after: null,
};
const health = {
  address: "service.analytics", kind: "resource.update", severity: "safe", field: "deploy",
  path: "resources.service.analytics.deploy",
  before: { healthcheckPath: "/api/heartbeat", multiRegionConfig: {} },
  after: { healthcheckPath: "/runport/health", multiRegionConfig: {} },
  details: ['deploy.healthcheckPath ("/api/heartbeat" → "/runport/health")'],
};

test("the analytics cutover allows only the four inspected changes", () => {
  const changes = [source, health, variable("service.analytics", "ANALYTICS_INGEST_SECRET"),
    variable("service.monitor", "ANALYTICS_HEALTH_URL")];
  expect(() => assertAnalyticsPlan(plan(changes))).not.toThrow();
  expect(() => assertGitPlan(plan(changes))).toThrow();
  expect(() => assertAnalyticsPlan(plan(changes), true)).toThrow();
  expect(() => assertAnalyticsPlan({ ...plan(changes), claim: true })).toThrow();
  for (const blocked of [
    variable("service.git", "GIT_BACKUP_TOKEN"), variable("service.monitor", "GIT_HEALTH_URL"),
    variable("service.analytics", "APP_SECRET"), { ...source, kind: "resource.delete" },
    { ...health, details: [...health.details, "deploy.replicas changed"] },
    { ...health, after: { ...health.after, sleepApplication: true } },
  ]) expect(() => assertAnalyticsPlan(plan([blocked]))).toThrow();
});

// Railway 5.71 bundles the deploy settings and variables into resource.create
// on an empty service, rather than listing those fields as updates.
const literal = (value: string) => ({ type: "literal", value });
const freshAnalytics = {
  address: "service.analytics", kind: "resource.create", severity: "safe",
  path: "resources.service.analytics",
  resource: {
    address: "service.analytics", type: "service", kind: "empty", name: "analytics",
    deploy: { healthcheckPath: "/runport/health", multiRegionConfig: { "europe-west4-drams3a": { numReplicas: 1 } } },
    variables: {
      PORT: literal("3000"), DISABLE_TELEMETRY: literal("1"), DISABLE_UPDATES: literal("1"), PRIVATE_MODE: literal("1"),
      SALT_ROTATION: literal("day"), CLIENT_IP_HEADER: literal("x-runport-visitor-ip"),
      APP_SECRET: literal("a".repeat(64)), ANALYTICS_INGEST_SECRET: literal("b".repeat(64)),
      DATABASE_URL: literal("postgresql://runport_analytics:fixture@postgresql.railway.internal:5432/runport_analytics"),
    },
  },
};

test("fresh analytics installs use the existing database and configure only their job variables", () => {
  const backup = { ...variable("service.backup", "ANALYTICS_DATABASE"), after: literal("runport_analytics") };
  const monitor = variable("service.monitor", "ANALYTICS_HEALTH_URL");
  expect(() => assertAnalyticsPlan(plan([freshAnalytics, backup, monitor]))).not.toThrow();
  expect(() => assertAnalyticsPlan(plan([backup]))).toThrow();
  for (const unrelated of [
    variable("service.git", "GIT_BACKUP_TOKEN"),
    { ...backup, after: literal("appwrite") },
    { ...freshAnalytics, address: "service.git", path: "resources.service.git" },
    { ...freshAnalytics, address: "volume.analytics-data", path: "resources.volume.analytics-data" },
    { ...freshAnalytics, kind: "resource.delete" },
  ]) expect(() => assertAnalyticsPlan(plan([freshAnalytics, unrelated]))).toThrow();
  for (const overrides of [
    { volumeMounts: { "git-data": { mountPath: "/data" } } },
    { variables: { ...freshAnalytics.resource.variables, DATABASE_URL: literal("postgresql://user:fixture@other.example:5432/appwrite") } },
    { variables: { ...freshAnalytics.resource.variables, NEXT_PUBLIC_SECRET: literal("fixture") } },
    { deploy: { ...freshAnalytics.resource.deploy, healthcheckPath: "/api/heartbeat" } },
  ]) expect(() => assertAnalyticsPlan(plan([{ ...freshAnalytics, resource: { ...freshAnalytics.resource, ...overrides } }]))).toThrow();
});
