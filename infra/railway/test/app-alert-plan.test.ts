import { expect, test } from "bun:test";
import { assertAppAlertsPlan } from "../check-git-plan";

const plan = (changes: unknown[], extra = {}) => ({
  kind: "railway.config.plan", version: 1, destructive: false, changeSet: { changes }, ...extra,
});

test("the app alerts apply attaches only the existing detached gateway volume at /data", () => {
  const mount = { mountPath: "/data", volume: "volume.mail-gateway-data" };
  const attachment = {
    kind: "resource.update", severity: "safe", address: "service.mail-gateway",
    field: "volumeAttachments", path: "resources.service.mail-gateway.volumeAttachments",
    before: null, after: { "mail-gateway-data": mount },
  };
  const production = { environmentId: "d95ac74a-26dc-4738-8765-3ab1389e057f" };
  expect(() => assertAppAlertsPlan(plan([attachment], production), false, true)).not.toThrow();
  expect(() => assertAppAlertsPlan(plan([attachment], production))).toThrow();
  expect(() => assertAppAlertsPlan(plan([attachment]), false, true)).toThrow();
  const owner = variable("service.mail-gateway", "ALERT_TO", "ludvig@ludvighedin.com");
  expect(() => assertAppAlertsPlan(plan([attachment, owner], production), false, true)).toThrow();
  expect(() => assertAppAlertsPlan(plan([attachment, owner], production))).toThrow();
  for (const change of [
    { ...attachment, before: { "mail-gateway-data": mount } },
    { ...attachment, after: null },
    { ...attachment, after: { "mail-gateway-data": { ...mount, mountPath: "/tmp" } } },
    { ...attachment, after: { "mail-gateway-data": { ...mount, volume: "volume.git-data" } } },
    { ...attachment, after: { "mail-gateway-data": mount, "git-data": mount } },
    { ...attachment, after: { "mail-gateway-data": { ...mount, sizeMB: 1000 } } },
    { ...attachment, address: "service.git", path: "resources.service.git.volumeAttachments" },
    { ...attachment, address: "volume.mail-gateway-data", kind: "resource.create" },
  ]) {
    expect(() => assertAppAlertsPlan(plan([change], production), false, true)).toThrow();
  }
});
const variable = (address: string, key: string, value: string) => ({
  kind: "variable.set", severity: "safe", address, variable: key,
  path: `resources.${address}.variables.${key}`, after: { type: "literal", value },
});

test("the app alerts apply allows only its own credentials and the owner address", () => {
  const changes = [
    variable("service.monitor", "RUNPORT_ALERT_MONITOR_KEY", "a".repeat(64)),
    variable("service.mail-gateway", "ALERT_TO", "ludvig@ludvighedin.com"),
  ];
  expect(() => assertAppAlertsPlan(plan(changes))).not.toThrow();
  for (const change of [
    variable("service.monitor", "RAILWAY_MONITOR_TOKEN", "fixture-read-token-only"),
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
