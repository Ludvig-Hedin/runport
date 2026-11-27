import { SQL } from "bun";
import { analyticsGateway } from "./gateway.ts";

const origin = "http://127.0.0.1:3001";
const secret = process.env.ANALYTICS_INGEST_SECRET ?? "";
const database = process.env.DATABASE_URL;
if (!database) throw new Error("Analytics DATABASE_URL is required.");
const sql = new SQL({ url: database, max: 1, connectionTimeout: 3, idleTimeout: 15 });
const handle = analyticsGateway({
  secret, upstream: origin,
  ready: async () => {
    const heartbeat = await fetch(origin + "/api/heartbeat", { signal: AbortSignal.timeout(3000) });
    if (!heartbeat.ok) return false;
    await sql`SELECT 1 FROM website LIMIT 1`;
    return true;
  },
});

const umamiEnv = { ...process.env };
delete umamiEnv.ANALYTICS_INGEST_SECRET;
const migrationEnv = { ...umamiEnv, PATH: `${process.cwd()}/node_modules/.bin:${process.env.PATH}` };
for (const script of ["scripts/check-db.js", "scripts/update-tracker.js"]) {
  const child = Bun.spawn(["node", script], { env: migrationEnv, stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) process.exit(1);
}

const umami = Bun.spawn(["node", "server.js"], {
  env: { ...umamiEnv, PORT: "3001", HOSTNAME: "127.0.0.1" },
  stdout: "inherit", stderr: "inherit",
});
const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  fetch: handle,
  maxRequestBodySize: 1_048_576,
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.stop(true);
    umami.kill(signal);
  });
}
process.exit(await umami.exited);
