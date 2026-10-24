import { readFileSync } from "node:fs";
import { bucket, defineRailway, image, project, ref, service, volume } from "railway/iac";

// Sitedock on Railway: Appwrite 2.6.1 from its official images, the mail
// gateway (delivering through Cloudflare, infra/cloudflare-mail) and one
// public router. Usage statistics are off, so there is no ClickHouse. Run through ../apply.sh,
// which reads the secrets from the macOS Keychain into SD_* variables so they
// never sit in this file or in the repo.

const APPWRITE = "appwrite/appwrite:2.6.1";
const REGION_ID = "europe-west4-drams3a"; // Amsterdam
const REGION = { [REGION_ID]: 1 };
/** Matches what Railway created, so plans stay clean. */
const DISK = { region: REGION_ID, sizeMB: 50000 };

const secret = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing. Run infra/railway/apply.sh, not railway config directly.`);
  return value;
};

/** infra/railway/appwrite.env: the non-secret settings copied from the local install. */
const baseEnv = (): Record<string, string> =>
  Object.fromEntries(
    readFileSync(new URL("../appwrite.env", import.meta.url), "utf8")
      .split("\n")
      .filter((line) => /^[A-Z0-9_]+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );

export default defineRailway(() => {
  const domain = secret("SD_PUBLIC_DOMAIN");
  const files = bucket("appwrite-files", { region: "ams" });

  const appwriteEnv = {
    ...baseEnv(),
    // Appwrite listens on $PORT, which Railway sets to its own default; the
    // router expects the API and realtime on 80.
    PORT: "80",
    _APP_DOMAIN: domain,
    _APP_DOMAIN_TARGET: domain,
    _APP_DOMAIN_TARGET_CNAME: domain,
    _APP_DOMAIN_FUNCTIONS: `functions.${domain}`,
    _APP_DOMAIN_SITES: `sites.${domain}`,
    _APP_PWNED_PASSWORDS_DSN: "none://localhost",
    _APP_OPENSSL_KEY_V1: secret("SD_OPENSSL_KEY"),
    _APP_DB_PASS: secret("SD_DB_PASS"),
    _APP_DB_ROOT_PASS: secret("SD_DB_ROOT_PASS"),
    _APP_EXECUTOR_SECRET: secret("SD_EXECUTOR_SECRET"),
    _APP_JOBS_SECRET: secret("SD_JOBS_SECRET"),
    _APP_GEO_SECRET: secret("SD_GEO_SECRET"),
    _APP_NOTIFICATIONS_TRACKING_SECRET: secret("SD_TRACKING_SECRET"),
    _APP_USAGE_PASS: secret("SD_USAGE_PASS"),
    _APP_CONNECTIONS_DB_USAGE: `http://appwrite:${secret("SD_USAGE_PASS")}@clickhouse.railway.internal:8123/appwrite`,
    _APP_CONNECTIONS_DB_EXECUTIONS: `http://appwrite:${secret("SD_USAGE_PASS")}@clickhouse.railway.internal:8123/appwrite`,
    _APP_SMTP_PASSWORD: secret("SD_SMTP_SYSTEM_PASSWORD"),
    _APP_STORAGE_S3_BUCKET: ref(files, "BUCKET"),
    _APP_STORAGE_S3_ACCESS_KEY: ref(files, "ACCESS_KEY_ID"),
    _APP_STORAGE_S3_SECRET: ref(files, "SECRET_ACCESS_KEY"),
    _APP_STORAGE_S3_REGION: ref(files, "REGION"),
    _APP_STORAGE_S3_ENDPOINT: ref(files, "ENDPOINT"),
  };

  const appwritePart = (name: string, start?: string) =>
    service(name, {
      source: image(APPWRITE),
      ...(start ? { start } : {}),
      replicas: REGION,
      env: appwriteEnv,
    });

  const postgresData = volume("postgresql-data", DISK);
  const postgresql = service("postgresql", {
    source: image("appwrite/postgres:0.1.0"),
    replicas: REGION,
    volumeMounts: { "postgresql-data": { mountPath: "/var/lib/postgresql" } },
    env: {
      POSTGRES_DB: "appwrite",
      POSTGRES_USER: "user",
      POSTGRES_PASSWORD: secret("SD_DB_PASS"),
      PGDATA: "/var/lib/postgresql/data/pgdata",
    },
  });

  const redisData = volume("redis-data", DISK);
  const redis = service("redis", {
    source: image("redis:7.4.7-alpine"),
    start: "redis-server --maxmemory 512mb --maxmemory-policy allkeys-lru --maxmemory-samples 5",
    replicas: REGION,
    volumeMounts: { "redis-data": { mountPath: "/data" } },
  });


  const geo = service("appwrite-geo", { source: image("appwrite/geo:0.3.2"), replicas: REGION });

  const console_ = service("appwrite-console", {
    source: image("appwrite/new:1.2.97-self-hosted"),
    replicas: REGION,
    // Only the owner uses the admin. It sleeps after 10 idle minutes and
    // wakes on the next visit, which takes a few seconds.
    deploy: { sleepApplication: true },
    env: { PORT: "3000", VITE_APPWRITE_VERSION: "2.6.1" },
  });

  const gatewayData = volume("mail-gateway-data", DISK);
  const mailGateway = service("mail-gateway", {
    // Built from infra/mail-gateway with `railway up`; no source here.
    replicas: REGION,
    volumeMounts: { "mail-gateway-data": { mountPath: "/data" } },
    env: {
      GATEWAY_MASTER_KEY: secret("SD_MAIL_MASTER_KEY"),
      DELIVERY: "cloudflare",
      CLOUDFLARE_MAIL_URL: "https://sitedock-mail.ludvighedin15.workers.dev/",
      CLOUDFLARE_MAIL_TOKEN: secret("SD_CF_MAIL_TOKEN"),
      MAIL_DAILY_LIMIT: "1000",
      MAIL_APP_DAILY_LIMIT: "300",
      MAIL_APP_NEWS_DAILY_LIMIT: "500",
      MAIL_NEWS_SHARE_PERCENT: "70",
      SENDER_DOMAINS: "runport.app,apps.ludvighedin.com",
    },
  });


  const router = service("router", {
    // Built from infra/railway/router with `railway up`; no source here.
    replicas: REGION,
    healthcheck: "/health",
  });

  // Scheduled jobs from infra/railway/ops (deployed with `railway up`).
  const opsEnv = {
    S3_ACCESS_KEY_ID: ref(files, "ACCESS_KEY_ID"),
    S3_SECRET_ACCESS_KEY: ref(files, "SECRET_ACCESS_KEY"),
    S3_BUCKET: ref(files, "BUCKET"),
    S3_ENDPOINT: ref(files, "ENDPOINT"),
    S3_REGION: ref(files, "REGION"),
    CLOUDFLARE_MAIL_URL: "https://sitedock-mail.ludvighedin15.workers.dev/",
    CLOUDFLARE_MAIL_TOKEN: secret("SD_CF_MAIL_TOKEN"),
    ALERT_TO: "ludvig@ludvighedin.com",
  };
  const backup = service("backup", {
    replicas: REGION,
    start: "bun backup.ts",
    deploy: { cronSchedule: "0 1 * * *", restartPolicyType: "NEVER" },
    env: {
      ...opsEnv,
      PGHOST: "postgresql.railway.internal",
      PGUSER: "user",
      PGPASSWORD: secret("SD_DB_PASS"),
      PGDATABASE: "appwrite",
      KEEP_DAYS: "14",
    },
  });
  const monitor = service("monitor", {
    replicas: REGION,
    start: "bun monitor.ts",
    deploy: { cronSchedule: "*/5 * * * *", restartPolicyType: "NEVER" },
    env: { ...opsEnv, ALERT_EVERY_HOURS: "3" },
  });

  return project("sitedock", {
    resources: [
      files,
      postgresData,
      postgresql,
      redisData,
      redis,
      geo,
      appwritePart("appwrite"),
      appwritePart("appwrite-realtime", "realtime"),
      appwritePart("appwrite-worker", "worker"),
      appwritePart("appwrite-task-scheduler", "schedule"),
      appwritePart("appwrite-task-maintenance", "maintenance"),
      appwritePart("appwrite-task-interval", "interval"),
      console_,
      gatewayData,
      mailGateway,
      router,
      backup,
      monitor,
    ],
  });
});
