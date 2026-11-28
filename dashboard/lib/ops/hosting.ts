// Pause and resume an app's hosting on Railway, tracking the exact
// deployment that was serving. No I/O of its own: `gql` is injected, so this
// is tested with fakes.

export type Gql = <T>(query: string, variables: Record<string, unknown>) => Promise<T>;
export type Pins = { projectId: string; environmentId: string; serviceId: string };
export type Deployment = { id: string; status: string; createdAt: string; deploymentStopped: boolean | null };

/** Serving now, or able to wake up and serve: a running or sleeping deployment. */
export const isServing = (d: Deployment) => d.status === "SLEEPING" || (d.status === "SUCCESS" && !d.deploymentStopped);
const isStarting = (d: Deployment) => ["BUILDING", "DEPLOYING", "INITIALIZING", "QUEUED", "WAITING"].includes(d.status);

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

/**
 * Stops every serving deployment (a sleeping one cannot be stopped, so it is
 * removed), then waits until Railway confirms none serves. Returns the one
 * that was serving, to resume later.
 */
export async function pauseHosting(gql: Gql, pins: Pins, opts: { tries?: number; delayMs?: number } = {}): Promise<Deployment | null> {
  const serving = (await deployments(gql, pins)).filter(isServing);
  for (const d of serving) {
    if (d.status === "SLEEPING") await gql(`mutation($id: String!) { deploymentRemove(id: $id) }`, { id: d.id });
    else await gql(`mutation($id: String!) { deploymentStop(id: $id) }`, { id: d.id });
  }
  for (let i = 0; i < (opts.tries ?? 15); i++) {
    if (!(await deployments(gql, pins)).some(isServing)) return serving[0] ?? null;
    await wait(opts.delayMs ?? 2000);
  }
  throw new Error("Railway did not confirm that the app stopped.");
}

/** Starts the deployment that was paused again, from its existing image. */
export async function resumeHosting(gql: Gql, pins: Pins, pausedId: string | null): Promise<string> {
  const list = await deployments(gql, pins);
  if (list.some(isServing)) return list.find(isServing)!.id;
  const target = (pausedId && list.find((d) => d.id === pausedId)) || list.find((d) => d.status === "SUCCESS" || d.status === "REMOVED" || d.status === "SLEEPING");
  if (!target) throw new Error("There is no earlier deployment to start again.");
  const out = await gql<{ deploymentRedeploy: { id: string } }>(
    `mutation($id: String!) { deploymentRedeploy(id: $id, usePreviousImageTag: true) { id } }`,
    { id: target.id },
  ).catch(() => {
    throw new Error("Railway could not start the last version again. Its image may have expired; deploy the app again.");
  });
  return out.deploymentRedeploy.id;
}
