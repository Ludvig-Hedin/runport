import { expect, test } from "bun:test";
import { checkApp, checkDeployedApps } from "../infra/railway/ops/app-alert-monitor";

const app = { slug: "throwaway-app", registrationId: "registration", projectId: "project", serviceId: "service",
  environmentId: "env", domain: "test.up.railway.app", incident: null };
const makeDeployment = (status: string, instances: string[] = [], deploymentStopped = false) =>
  ({ status, deploymentStopped, instances: instances.map((status) => ({ status })) });

function inventory(nodes: object[], endCursor: string | null = null) {
  return Response.json({ data: { environment: { deletedAt: null, serviceInstances: {
    edges: nodes.map(node => ({ node })), pageInfo: { hasNextPage: endCursor !== null, endCursor },
  } } } });
}

const run = (latest: ReturnType<typeof makeDeployment>, active: ReturnType<typeof makeDeployment>[], sleep: boolean,
  http: number[] = [200], incident: number | null = null) => {
  const urls: string[] = [];
  const mock = async (url: string | URL | Request) => {
    urls.push(String(url));
    if (urls.length > 1) return new Response(null, { status: http.shift() ?? 503 });
    return inventory([{
      serviceId: app.serviceId, deletedAt: null, sleepApplication: sleep,
      activeDeployments: active, latestDeployment: latest,
    }]);
  };
  return checkApp({ ...app, incident }, "test-token", mock, async () => {}).then((result) => ({ result, urls }));
};

test("leaves explicitly sleeping apps alone and requires a successful wake before closing an outage", async () => {
  const sleeping = await run(makeDeployment("SLEEPING", ["STOPPED"]), [], true);
  expect(sleeping.result.status).toBe("sleeping");
  expect(sleeping.urls).toHaveLength(1);
  const waking = await run(makeDeployment("SLEEPING"), [], true, [502, 200], 99);
  expect(waking.result.status).toBe("up");
  expect(waking.urls).toHaveLength(3);
  expect((await run(makeDeployment("SLEEPING"), [], true, [502, 502], 99)).result.status).toBe("sleeping");
});

test("probes running services and allows a failed release with an older serving deployment", async () => {
  const live = [makeDeployment("SUCCESS", ["RUNNING"])];
  expect((await run(makeDeployment("FAILED"), live, false, [302])).result.status).toBe("up");
  expect((await run(makeDeployment("SUCCESS"), live, true, [502, 200])).result.status).toBe("up");
  expect((await run(makeDeployment("SUCCESS"), live, true, [503, 503])).result).toMatchObject({ status: "down", reason: "http" });
});

test("SUCCESS alone cannot clear a known outage or an exited process", async () => {
  expect((await run(makeDeployment("SUCCESS", ["EXITED"]), [], true, [502, 502])).result).toMatchObject({
    status: "down", reason: "exited",
  });
  expect((await run(makeDeployment("CRASHED"), [], true)).result).toMatchObject({ status: "down", reason: "crashed" });
  expect((await run(makeDeployment("SUCCESS", [], true), [], true)).result).toMatchObject({ status: "down", reason: "removed" });
  expect((await run(makeDeployment("BUILDING"), [], true)).result.status).toBe("unknown");
  expect((await checkApp(app, "test-token", async () => Response.json({ errors: [{ message: "unavailable" }] }))).status).toBe("unknown");
});

test("retires only confirmed deletion or absence after paginating the authorized environment", async () => {
  expect((await checkApp(app, "test-token", async () => inventory([{ serviceId: app.serviceId, deletedAt: "archived" }]))).status).toBe("retired");
  expect((await checkApp(app, "test-token", async () => Response.json({
    data: null, errors: [{ message: "Not Authorized", extensions: { code: "INTERNAL_SERVER_ERROR" } }],
  }))).status).toBe("unknown");
  const cursors: unknown[] = [];
  const result = await checkApp(app, "test-token", async (_url, req) => {
    const { after } = JSON.parse(String(req?.body)).variables;
    cursors.push(after);
    return after ? inventory([]) : inventory([{ serviceId: "a-different-service" }], "page-2");
  });
  expect(cursors).toEqual([null, "page-2"]);
  expect(result.status).toBe("retired");
  expect(result.registrationId).toBe(app.registrationId);
  expect((await checkApp(app, "test-token", async () => inventory([], "repeated-cursor"))).status).toBe("unknown");
});

test("a Railway 429 stops the batch and persists Retry-After without marking apps down", async () => {
  const requests: Array<{ url: string; body?: unknown }> = [];
  const request = async (url: URL | Request | string, init?: RequestInit) => {
    requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (requests.length === 1) return Response.json({ apps: [app, { ...app, slug: "second" }] });
    if (requests.length === 2) return new Response(null, { status: 429, headers: { "Retry-After": "600" } });
    return new Response(null, { status: 204 });
  };
  await checkDeployedApps({ RUNPORT_ALERT_MONITOR_KEY: "fixture", RAILWAY_MONITOR_TOKEN: "fixture" }, request);
  expect(requests).toHaveLength(3);
  expect(requests[2].body).toEqual({ observations: [], retryAfterMs: 600_000 });
});
