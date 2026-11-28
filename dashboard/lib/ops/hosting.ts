import { SafeError } from "./errors";

// Pause and resume an app's hosting on Railway, tracking the exact
// deployment that was serving. No I/O of its own: `gql` is injected, so this
// is tested with fakes.

export type Gql = <T>(query: string, variables: Record<string, unknown>) => Promise<T>;
export type Pins = { projectId: string; environmentId: string; serviceId: string };
export type Deployment = { id: string; status: string; createdAt: string; deploymentStopped: boolean | null };

/** Serving now, or able to wake up and serve: a running or sleeping deployment. */
export const isServing = (d: Deployment) => d.status === "SLEEPING" || (d.status === "SUCCESS" && !d.deploymentStopped);
/** On its way to serving. */
export const isStarting = (d: Deployment) => ["BUILDING", "DEPLOYING", "INITIALIZING", "QUEUED", "WAITING", "NEEDS_APPROVAL"].includes(d.status);

export async function deployments(gql: Gql, pins: Pins): Promise<Deployment[]> {
  const data = await gql<{ deployments: { edges: { node: Deployment }[] } }>(
    `query($p: String!, $e: String!, $s: String!) {
      deployments(first: 20, input: { projectId: $p, environmentId: $e, serviceId: $s }) { edges { node { id status createdAt deploymentStopped } } }
    }`,
    { p: pins.projectId, e: pins.environmentId, s: pins.serviceId },
  );
  return data.deployments.edges.map((e) => e.node);
}

export type HostingStatus = "live" | "sleeping" | "deploying" | "down" | "paused" | "unknown";

export function hostingStatus(list: Deployment[]): HostingStatus {
  const newest = list[0];
  if (!newest) return "unknown";
  if (isStarting(newest)) return "deploying";
  const serving = list.find(isServing);
  if (serving) return serving.status === "SLEEPING" ? "sleeping" : "live";
  if (newest.status === "FAILED" || newest.status === "CRASHED") return "down";
  return "paused";
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type StopOptions = { tries?: number; delayMs?: number; drainMs?: number };

/**
 * Stops the hosting completely: cancels anything queued, building or
 * deploying, stops every serving deployment (a sleeping one cannot be stopped,
 * so it is removed), waits until Railway confirms nothing serves or starts,
 * then waits `drainMs` for requests already in flight. Returns the deployment
 * that was serving, to resume later.
 */
export async function stopHosting(gql: Gql, pins: Pins, opts: StopOptions = {}): Promise<Deployment | null> {
  let paused: Deployment | null = null;
  for (let i = 0; i < (opts.tries ?? 20); i++) {
    const list = await deployments(gql, pins);
    const serving = list.filter(isServing);
    const starting = list.filter(isStarting);
    if (!serving.length && !starting.length) {
      if (opts.drainMs) await wait(opts.drainMs);
      // Check once more after the drain: nothing may have started meanwhile.
      const after = await deployments(gql, pins);
      if (!after.some(isServing) && !after.some(isStarting)) return paused;
      continue;
    }
    paused ??= serving[0] ?? null;
    for (const d of starting) await gql(`mutation($id: String!) { deploymentCancel(id: $id) }`, { id: d.id }).catch(() => {});
    for (const d of serving) {
      if (d.status === "SLEEPING") await gql(`mutation($id: String!) { deploymentRemove(id: $id) }`, { id: d.id });
      else await gql(`mutation($id: String!) { deploymentStop(id: $id) }`, { id: d.id });
    }
    await wait(opts.delayMs ?? 2000);
  }
  throw new SafeError("Railway did not confirm that the app stopped.");
}

type Owned = Deployment & { projectId: string; environmentId: string; serviceId: string };

/**
 * Starts the paused deployment again, from its own image. A recorded
 * deployment is looked up by id when it is not among the newest; if it is
 * gone or belongs elsewhere, resume refuses rather than start another image.
 */
export async function resumeHosting(gql: Gql, pins: Pins, pausedId: string | null): Promise<string> {
  const list = await deployments(gql, pins);
  const already = list.find(isServing);
  if (already) return already.id;
  let target: Deployment | undefined;
  if (pausedId) {
    target = list.find((d) => d.id === pausedId);
    if (!target) {
      const found = await gql<{ deployment: Owned | null }>(
        `query($id: String!) { deployment(id: $id) { id status createdAt deploymentStopped projectId environmentId serviceId } }`,
        { id: pausedId },
      ).catch(() => ({ deployment: null }));
      const d = found.deployment;
      if (!d || d.projectId !== pins.projectId || d.environmentId !== pins.environmentId || d.serviceId !== pins.serviceId) {
        throw new SafeError("The version that was paused can no longer be found. Deploy the app again.");
      }
      target = d;
    }
  } else {
    // Nothing was recorded (paused outside the dashboard): the newest version that ran.
    target = list.find((d) => d.status === "SUCCESS" || d.status === "REMOVED" || d.status === "SLEEPING");
  }
  if (!target) throw new SafeError("There is no earlier version to start again.");
  const out = await gql<{ deploymentRedeploy: { id: string } }>(
    `mutation($id: String!) { deploymentRedeploy(id: $id, usePreviousImageTag: true) { id } }`,
    { id: target.id },
  ).catch(() => {
    throw new SafeError("Railway could not start the paused version again. Its image may have expired; deploy the app again.");
  });
  return out.deploymentRedeploy.id;
}
