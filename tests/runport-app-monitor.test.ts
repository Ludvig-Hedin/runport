import { expect, test } from "bun:test";
import { checkApp } from "../infra/railway/ops/app-alert-monitor";

const app = { slug: "throwaway-app", serviceId: "service", environmentId: "env", domain: "test.up.railway.app" };
const run = (latest: string, active: string[], sleep: boolean, http = 200, stopped = false) => {
  const urls: string[] = [];
  const mock = async (url: string | URL | Request) => {
    urls.push(String(url));
    if (urls.length > 1) return new Response(null, { status: http });
    return Response.json({ data: { serviceInstance: {
      sleepApplication: sleep,
      activeDeployments: active.map((status) => ({ status, deploymentStopped: false })),
      latestDeployment: { status: latest, deploymentStopped: stopped },
    } } });
  };
  return checkApp(app, "test-token", mock).then((result) => ({ result, urls }));
};

test("never wakes sleeping or sleep-enabled apps", async () => {
  const sleeping = await run("SLEEPING", [], true);
  expect(sleeping.result.status).toBe("sleeping");
  expect(sleeping.urls).toHaveLength(1);
  const active = await run("SUCCESS", ["SUCCESS"], true);
  expect(active.result.status).toBe("up");
  expect(active.urls).toHaveLength(1);
});

test("recognizes a failed release with an older serving deployment and probes only an always-on app", async () => {
  expect((await run("FAILED", ["SUCCESS"], false, 302)).result.status).toBe("up");
  expect((await run("SUCCESS", ["SUCCESS"], false, 503)).result).toMatchObject({ status: "down", reason: "http" });
});

test("recognizes crashes and stopped apps and leaves in-progress and API failures unknown", async () => {
  expect((await run("CRASHED", [], true)).result).toMatchObject({ status: "down", reason: "crashed" });
  expect((await run("SUCCESS", [], true, 200, true)).result).toMatchObject({ status: "down", reason: "removed" });
  expect((await run("BUILDING", [], true)).result.status).toBe("unknown");
  const apiError = async () => Response.json({ errors: [{ message: "unavailable" }] });
  expect((await checkApp(app, "test-token", apiError)).status).toBe("unknown");
});
