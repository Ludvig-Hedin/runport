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
