import { service } from "railway/iac";

export const analyticsDatabase = "runport_analytics";

export function analyticsService(replicas: Record<string, number>, databasePassword: string, appSecret: string, ingestSecret: string) {
  return service("analytics", {
    // Deployed from ../analytics with railway up.
    replicas,
    healthcheck: "/runport/health",
    env: {
      PORT: "3000",
      DATABASE_URL: `postgresql://runport_analytics:${encodeURIComponent(databasePassword)}@postgresql.railway.internal:5432/${analyticsDatabase}`,
      APP_SECRET: appSecret,
      ANALYTICS_INGEST_SECRET: ingestSecret,
      DISABLE_TELEMETRY: "1",
      DISABLE_UPDATES: "1",
      PRIVATE_MODE: "1",
      SALT_ROTATION: "day",
      CLIENT_IP_HEADER: "x-runport-visitor-ip",
    },
  });
}
