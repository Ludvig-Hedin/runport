import { Database } from "bun:sqlite";

type Connection<T> = { edges: { node: T }[]; pageInfo: { hasNextPage: boolean } };
type Deployment = { deploymentStopped: boolean };
type StorageState = {
  errors?: unknown[];
  data?: {
    environment?: {
      id: string;
      volumeInstances: Connection<{ id: string; mountPath: string; serviceId: string | null; state: string; volume: { name: string } }>;
      serviceInstances: Connection<{ serviceId: string; activeDeployments: Deployment[]; latestDeployment: Deployment | null }>;
    };
  };
};

const gateway = "8c4bedd8-5d19-42e7-8f05-3289f4f8dff0";
const volumeId = "744eff6f-4274-4170-81e7-b920a773870d";
type Mode = "mounted" | "mounted-stopped" | "detached-stopped";

export function assertMailStorage(state: StorageState, mode: Mode): void {
  const env = state.data?.environment;
  if (state.errors?.length || env?.id !== "d95ac74a-26dc-4738-8765-3ab1389e057f" ||
      env.volumeInstances.pageInfo.hasNextPage || env.serviceInstances.pageInfo.hasNextPage) {
    throw new Error("Could not verify Runport production storage and runtime.");
  }
  const instance = env.volumeInstances.edges.find(({ node }) => node.id === volumeId)?.node;
  if (!instance || instance.volume.name !== "mail-gateway-data" || instance.state !== "READY") {
    throw new Error("Expected the existing Runport mail volume to be ready.");
  }
  if (mode === "detached-stopped" ? instance.serviceId !== null : instance.serviceId !== gateway || instance.mountPath !== "/data") {
    throw new Error("Runport mail volume is not in the required attachment state.");
  }
  if (mode !== "mounted") {
    const service = env.serviceInstances.edges.find(({ node }) => node.serviceId === gateway)?.node;
    if (!service?.latestDeployment?.deploymentStopped ||
        service.activeDeployments.some(deployment => deployment.deploymentStopped !== true)) {
      throw new Error("The legacy gateway must be stopped before changing or preparing its storage.");
    }
  }
}

if (import.meta.main) {
  try {
    const [mode, snapshot] = process.argv.slice(2);
    if (mode !== "mounted" && mode !== "mounted-stopped" && mode !== "detached-stopped") throw new Error("Invalid mail storage check.");
    assertMailStorage(JSON.parse(await Bun.stdin.text()), mode);
    if (mode === "detached-stopped") {
      const file = Bun.file(snapshot ?? "");
      if (!snapshot || !(await file.exists()) || Date.now() - file.lastModified > 30 * 60_000) {
        throw new Error("A fresh cutover snapshot of the stopped gateway is required.");
      }
      const db = new Database(snapshot, { readonly: true });
      try {
        const results = db.query("PRAGMA integrity_check").values();
        if (results.length !== 1 || results[0]?.[0] !== "ok") throw new Error("Cutover snapshot failed integrity_check.");
        db.query("SELECT day, app, kind, recipients FROM sent_by_kind LIMIT 0").all();
      } finally {
        db.close();
      }
    }
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
