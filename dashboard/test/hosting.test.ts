import { expect, test } from "bun:test";
import { type Deployment, type Gql, hostingStatus, pauseHosting, resumeHosting } from "../lib/ops/hosting";

// A fake Railway that behaves like the real one where it matters:
// a sleeping deployment cannot be stopped, only removed; a redeploy makes a
// new deployment from the old one's image (unless the image has expired).

const pins = { projectId: "p", environmentId: "e", serviceId: "s" };

function fakeRailway(initial: Deployment[], opts: { imageExpired?: boolean } = {}) {
  const list = initial.map((d) => ({ ...d }));
  const calls: string[] = [];
  let n = 0;
  const gql: Gql = async <T,>(query: string, vars: Record<string, unknown>): Promise<T> => {
    const id = vars.id as string;
    const d = list.find((x) => x.id === id);
    if (query.includes("deploymentStop(")) {
      calls.push(`stop:${id}`);
      if (d!.status === "SLEEPING") throw new Error("Deployment is not stoppable");
      d!.deploymentStopped = true;
      return { deploymentStop: true } as T;
    }
    if (query.includes("deploymentRemove(")) {
      calls.push(`remove:${id}`);
      d!.status = "REMOVED";
      return { deploymentRemove: true } as T;
    }
    if (query.includes("deploymentRedeploy(")) {
      calls.push(`redeploy:${id}`);
      if (opts.imageExpired) throw new Error("image not found");
      const fresh = { id: `new-${++n}`, status: "SUCCESS", createdAt: "2026-11-28T12:00:00Z", deploymentStopped: false };
      list.unshift(fresh);
      return { deploymentRedeploy: { id: fresh.id } } as T;
    }
    return { deployments: { edges: list.map((node) => ({ node: { ...node } })) } } as T;
  };
  return { gql, list, calls };
}

const dep = (id: string, status: string, stopped = false): Deployment => ({ id, status, createdAt: "2026-11-27T10:00:00Z", deploymentStopped: stopped });

test("pausing a sleeping app removes the sleeping deployment and confirms nothing serves", async () => {
  const rw = fakeRailway([dep("d1", "SLEEPING", true)]);
  expect(hostingStatus(rw.list)).toBe("sleeping");
  const paused = await pauseHosting(rw.gql, pins, { delayMs: 0 });
  expect(paused?.id).toBe("d1");
  expect(rw.calls).toEqual(["remove:d1"]);
  expect(hostingStatus(rw.list)).toBe("paused");
});

test("pausing an awake app stops the deployment that is actually serving", async () => {
  // A newer deployment failed; the older one still serves traffic.
  const rw = fakeRailway([dep("d2", "FAILED"), dep("d1", "SUCCESS")]);
  expect(hostingStatus(rw.list)).toBe("live");
  const paused = await pauseHosting(rw.gql, pins, { delayMs: 0 });
  expect(paused?.id).toBe("d1");
  expect(rw.calls).toEqual(["stop:d1"]);
  expect(hostingStatus(rw.list)).toBe("down");
});

test("resuming a sleeping app that was paused starts exactly that deployment again", async () => {
  const rw = fakeRailway([dep("d2", "FAILED"), dep("d1", "SLEEPING", true)]);
  const paused = await pauseHosting(rw.gql, pins, { delayMs: 0 });
  const started = await resumeHosting(rw.gql, pins, paused!.id);
  expect(rw.calls).toEqual(["remove:d1", "redeploy:d1"]);
  expect(started).toBe("new-1");
  expect(hostingStatus(rw.list)).toBe("live");
});

test("pause reports failure when Railway never confirms the stop", async () => {
  const rw = fakeRailway([dep("d1", "SUCCESS")]);
  const stuck: Gql = async (q, v) => (q.includes("deploymentStop(") ? ({ deploymentStop: true } as never) : rw.gql(q, v));
  await expect(pauseHosting(stuck, pins, { tries: 2, delayMs: 0 })).rejects.toThrow("did not confirm");
});

test("resume explains an expired image instead of failing silently", async () => {
  const rw = fakeRailway([dep("d1", "REMOVED")], { imageExpired: true });
  await expect(resumeHosting(rw.gql, pins, "d1")).rejects.toThrow("expired");
});

test("resume does nothing when something already serves", async () => {
  const rw = fakeRailway([dep("d1", "SUCCESS")]);
  expect(await resumeHosting(rw.gql, pins, "d1")).toBe("d1");
  expect(rw.calls).toEqual([]);
});
