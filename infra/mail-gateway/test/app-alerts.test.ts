import { expect, test } from "bun:test";
import { createAppAlerts, monitorKey, registrationKey, reportKey } from "../src/app-alerts";
import { Limits } from "../src/limits";

const master = "isolated-test-secret";
const slug = "throwaway-app";
const deployment = {
  slug,
  projectId: "00000000-0000-0000-0000-000000000001",
  environmentId: "00000000-0000-0000-0000-000000000002",
  serviceId: "00000000-0000-0000-0000-000000000003",
  domain: "throwaway.up.railway.app",
};
const error = { source: "route", kind: "TypeError", fingerprint: "a".repeat(64) };

function fixture(total = 100) {
  const inbox: Array<{ to: string[]; raw: string }> = [];
  const limits = new Limits(":memory:", { total, perApp: 30, perAppNews: 30, newsShare: 0.7 });
  const handle = createAppAlerts({
    path: ":memory:", master, limits,
    deliver: async ({ to }, raw) => {
      inbox.push({ to, raw: raw.toString() });
      return 1;
    },
    log: () => {},
  });
  const request = (path: string, token: string, body?: unknown) => handle(new Request("https://runport.invalid" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const register = () => request("/_runport/alerts/register/" + slug, registrationKey(master), deployment);
  const report = (body: unknown = error) => request("/_runport/alerts/report/" + slug, reportKey(master, slug), body);
  const poll = (body: unknown) => request("/internal/app-alerts", monitorKey(master), body);
  return { inbox, limits, request, register, report, poll };
}

test("registered errors are deduplicated, counted, and sent only to the owner", async () => {
  const f = fixture();
  expect((await f.report()).status).toBe(404);
  expect((await f.register()).status).toBe(204);
  expect((await f.request("/_runport/alerts/register/" + slug, reportKey(master, slug), deployment)).status).toBe(401);
  expect((await f.request("/internal/app-alerts", registrationKey(master))).status).toBe(401);
  expect((await f.request("/_runport/alerts/report/" + slug, reportKey(master, "other-app"), error)).status).toBe(401);
  await Promise.all(Array.from({ length: 5 }, () => f.report()));
  await f.report({ ...error, source: "browser" });
  await f.poll([]);
  await f.poll([]);
  expect(f.inbox).toHaveLength(2);
  expect(f.inbox[0].to).toEqual(["ludvig@ludvighedin.com"]);
  expect(f.inbox[0].raw).toContain("Antal: 5");
  expect(f.inbox[0].raw).toContain("https://railway.com/project/");
  expect(f.limits.today().apps[slug].mail).toBe(2);
});

test("rejects raw fields and caps report traffic and new error types", async () => {
  const f = fixture();
  await f.register();
  expect((await f.report({ ...error, message: "person@example.test?token=secret" })).status).toBe(400);
  const statuses = await Promise.all(Array.from({ length: 130 }, (_, i) =>
    f.report({ ...error, fingerprint: i.toString(16).padStart(64, "0") }).then((r) => r.status)));
  expect(statuses).toContain(429);
  await f.poll([]);
  expect(f.inbox).toHaveLength(5);
  expect(f.inbox.every((m) => !m.raw.includes("person@example.test"))).toBe(true);
});

test("one outage and one recovery, with no incident for sleeping or unknown status", async () => {
  const f = fixture();
  await f.register();
  for (const status of ["sleeping", "unknown", "down", "down", "unknown", "sleeping", "up", "up"]) {
    await f.poll([{ slug, status, reason: "crashed" }]);
  }
  expect(f.inbox).toHaveLength(2);
  expect(f.inbox[0].raw).toContain("Appen ligger nere");
  expect(f.inbox[1].raw).toContain("Appen fungerar igen");
});

test("alerts share the existing mail caps", async () => {
  const f = fixture(0);
  await f.register();
  await f.report();
  await f.poll([]);
  expect(f.inbox).toHaveLength(0);
});
