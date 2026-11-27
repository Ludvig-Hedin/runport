import { expect, test } from "bun:test";
import { assertAppAlertsPlan } from "../check-git-plan";

const plan = (changes: unknown[], extra = {}) => ({
  kind: "railway.config.plan", version: 1, destructive: false, changeSet: { changes }, ...extra,
});
const variable = (address: string, key: string, value: string) => ({
  kind: "variable.set", severity: "safe", address, variable: key,
  path: `resources.${address}.variables.${key}`, after: { type: "literal", value },
});

test("the app alerts apply allows only its own credentials and the owner address", () => {
  const changes = [
    variable("service.monitor", "RAILWAY_MONITOR_TOKEN", "fixture-read-token-only"),
    variable("service.monitor", "RUNPORT_ALERT_MONITOR_KEY", "a".repeat(64)),
    variable("service.mail-gateway", "ALERT_TO", "ludvig@ludvighedin.com"),
  ];
  expect(() => assertAppAlertsPlan(plan(changes))).not.toThrow();
  for (const change of [
    variable("service.monitor", "ANALYTICS_HEALTH_URL", "https://analytics.example.test"),
    variable("service.monitor", "GIT_HEALTH_URL", "https://git.example.test"),
    variable("service.mail-gateway", "ALERT_TO", "other@example.test"),
    variable("service.mail-gateway", "RUNPORT_ALERT_MONITOR_KEY", "a".repeat(64)),
    { ...changes[0], kind: "resource.update" },
    { ...changes[1], severity: "destructive" },
  ]) {
    expect(() => assertAppAlertsPlan(plan([change]))).toThrow();
  }
  expect(() => assertAppAlertsPlan(plan(changes, { claim: true }))).toThrow();
  expect(() => assertAppAlertsPlan(plan(changes), true)).toThrow();
  expect(() => assertAppAlertsPlan(plan([]), true)).not.toThrow();
});
