import { expect, test } from "bun:test";
import { createAppAlerts, monitorKey, registrationKey, reportKey } from "../src/app-alerts";
import { DeliveryError } from "../src/deliver";
import { Limits } from "../src/limits";

const master = "isolated-test-secret";
const owner = "owner@runport.invalid";
const slug = "throwaway-app";
const deployment = {
  slug,
  projectId: "00000000-0000-0000-0000-000000000001",
  environmentId: "00000000-0000-0000-0000-000000000002",
  serviceId: "00000000-0000-0000-0000-000000000003",
  domain: "throwaway.up.railway.app",
};
const error = { source: "route", kind: "TypeError", fingerprint: "a".repeat(64) };
const appKey = (app: string) => reportKey(master, app, deployment.serviceId, deployment.environmentId);
const hour = 60 * 60_000;

function fixture({ total = 100, alertPerApp = 10, recipient = owner } = {}) {
  let now = Date.UTC(2026, 10, 10, 9);
  let failure: Error | undefined;
  const inbox: Array<{ to: string[]; raw: string }> = [];
  const limits = new Limits(":memory:", { total, perApp: 30, perAppNews: 30, newsShare: 0.7, alertTotal: 30, alertPerApp });
  const handle = createAppAlerts({
    path: ":memory:", master, owner: recipient, limits, clock: () => now,
    deliver: async ({ to }, raw) => {
      if (failure) throw failure;
      inbox.push({ to, raw: raw.toString() });
      return 1;
    },
    log: () => {},
  });
  const request = async (path: string, token: string, body?: unknown, method?: string) => handle(new Request("https://runport.invalid" + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const register = (app = slug) => request("/_runport/alerts/register/" + app, registrationKey(master), { ...deployment, slug: app });
  const report = (event: unknown = error, app = slug) =>
    request("/_runport/alerts/report/" + app, appKey(app), event);
  const poll = (statuses: string[] = [], wait = 0) => request("/internal/app-alerts", monitorKey(master), {
    observations: statuses.map(status => ({ ...deployment, status, reason: "crashed" })), retryAfterMs: wait,
  });
  const list = () => request("/internal/app-alerts", monitorKey(master));
  const stats = () => limits.today(new Date(now));
  return { inbox, limits, request, register, report, poll, list, stats, clock: () => now,
    tick: (time: number) => { now += time; }, fail: (error?: Error) => { failure = error; } };
}

test("server fingerprints are keyed, deduplicated, counted and emailed only to the configured owner", async () => {
  const f = fixture();
  expect((await f.report()).status).toBe(404);
  expect((await f.register()).status).toBe(204);
  expect((await f.request("/_runport/alerts/register/" + slug, appKey(slug), deployment)).status).toBe(401);
  expect((await f.request("/internal/app-alerts", registrationKey(master))).status).toBe(401);
  expect((await f.request("/_runport/alerts/report/" + slug, appKey("other-app"), error)).status).toBe(401);
  await Promise.all(Array.from({ length: 5 }, () => f.report()));
  await f.poll();
  await f.poll();
  expect(f.inbox).toHaveLength(1);
  expect(f.inbox[0].to).toEqual([owner]);
  expect(f.inbox[0].raw).toContain("Antal: 5");
  expect(f.inbox[0].raw).toContain("https://railway.com/project/");
  expect(f.inbox[0].raw).toMatch(/Fel-ID: [a-f0-9]{64}/);
  expect(f.inbox[0].raw).not.toContain(error.fingerprint);
  expect(f.stats().apps[slug].alert).toBe(1);
});

test("browser events produce one summary after Stockholm midnight without supplied strings", async () => {
  const f = fixture();
  await f.register();
  await f.report({ ...error, source: "browser" });
  await f.report({ ...error, source: "browser", fingerprint: "b".repeat(64) });
  await f.poll();
  expect(f.inbox).toHaveLength(0);
  f.tick(24 * hour);
  await f.poll();
  await f.poll();
  expect(f.inbox).toHaveLength(1);
  expect(f.inbox[0].raw).toContain("Daglig sammanfattning");
  expect(f.inbox[0].raw).toContain("Antal: 2");
  expect(f.inbox[0].raw).not.toContain("Fel-ID:");
  expect(f.inbox[0].raw).not.toContain(error.fingerprint);
});

test("rejects raw fields and caps report traffic and new server error types", async () => {
  const f = fixture();
  await f.register();
  expect((await f.report({ ...error, message: "person@example.test?token=secret" })).status).toBe(400);
  const statuses = await Promise.all(Array.from({ length: 130 }, (_, i) =>
    f.report({ ...error, fingerprint: i.toString(16).padStart(64, "0") }).then((r) => r.status)));
  expect(statuses).toContain(429);
  await f.poll();
  expect(f.inbox).toHaveLength(5);
  expect(f.inbox.every((m) => !m.raw.includes("person@example.test"))).toBe(true);
});

test("sleep and unknown statuses keep the incident open, and repeated flaps are suppressed for one hour", async () => {
  const f = fixture();
  await f.register();
  for (const status of ["sleeping", "unknown", "down", "down", "unknown", "sleeping"]) await f.poll([status]);
  expect(f.inbox).toHaveLength(1);
  expect(f.inbox[0].raw).toContain("Appen ligger nere");
  for (const status of ["up", "up", "down", "up"]) await f.poll([status]);
  expect(f.inbox).toHaveLength(2);
  expect(f.inbox[1].raw).toContain("Appen fungerar igen");
  f.tick(hour);
  await f.poll(["down"]);
  expect(f.inbox).toHaveLength(3);
});

test("a confirmed temporary refusal releases capacity and backs off, while ambiguous delivery is never repeated", async () => {
  const f = fixture();
  await f.register();
  f.fail(new DeliveryError("provider throttled", true));
  await f.report();
  await f.poll();
  expect(f.stats().total).toBe(0);
  f.fail();
  await f.poll();
  expect(f.inbox).toHaveLength(0);
  f.tick(5 * 60_000);
  await f.poll();
  expect(f.inbox).toHaveLength(1);
  f.fail(new DeliveryError("gateway lost provider ack", true, false));
  await f.report({ ...error, fingerprint: "b".repeat(64) });
  await f.poll();
  f.fail();
  f.tick(hour);
  await f.poll();
  expect(f.stats().total).toBe(2);
  expect(f.inbox).toHaveLength(1);
});

test("a backlog of over 50 events for a capped app cannot block another app", async () => {
  const f = fixture({ alertPerApp: 1 });
  const other = "later-app";
  await f.register();
  await f.register(other);
  for (let i = 0; i < 60; i++) {
    for (const status of ["down", "up"]) {
      const route = "/internal/app-alerts";
      await f.request(route, monitorKey(master), { observations: [{ ...deployment, status, reason: "crashed" }] }, "POST");
    }
    f.tick(hour);
  }
  // A capped app has dozens of undelivered incidents. The next app still sends.
  await f.report(error, other);
  await f.poll();
  expect(f.inbox.some(({ raw }) => raw.includes("App: " + other))).toBe(true);
});

test("prunes old fingerprints, retires only the matching deployment, and honors monitor backoff", async () => {
  const f = fixture();
  await f.register();
  await f.report();
  await f.poll();
  f.tick(31 * 24 * hour);
  await f.poll([], 600_000);
  expect(await (await f.list()).json()).toEqual({ apps: [] });
  f.tick(600_000);
  expect((await (await f.list()).json()).apps).toHaveLength(1);
  await f.report();
  await f.poll();
  expect(f.inbox).toHaveLength(2);
  const path = "/_runport/alerts/register/" + slug;
  expect((await f.request(path, appKey(slug), deployment, "DELETE")).status).toBe(401);
  await f.request(path, registrationKey(master), { ...deployment, serviceId: deployment.projectId }, "DELETE");
  expect((await f.report()).status).toBe(204);
  await f.poll(["retired"]);
  expect((await f.report()).status).toBe(404);
  await f.request(path, registrationKey(master), { ...deployment, serviceId: deployment.projectId });
  expect((await f.report()).status).toBe(401);
});

test("the feature fails closed with missing or multiple recipients, and observes gateway caps", async () => {
  expect((await fixture({ recipient: "" }).register()).status).toBe(503);
  expect((await fixture({ recipient: owner + ",other@example.test" }).register()).status).toBe(503);
  const f = fixture({ total: 0 });
  await f.register();
  await f.report();
  await f.poll();
  expect(f.inbox).toHaveLength(0);
});

test("a recovery waits for its outage alert to be delivered", async () => {
  const f = fixture();
  await f.register();
  f.fail(new DeliveryError("throttled", true));
  await f.poll(["down"]);
  f.fail();
  await f.poll(["up"]);
  expect(f.inbox).toHaveLength(0);
  f.tick(5 * 60_000);
  await f.poll();
  expect(f.inbox).toHaveLength(2);
  expect(f.inbox[0].raw).toContain("Appen ligger nere");
  expect(f.inbox[1].raw).toContain("Appen fungerar igen");
});
