import { readFileSync } from "node:fs";
import { bucket, defineRailway, empty, image, project, ref, service, volume } from "railway/iac";

// Sitedock on Railway: Appwrite 2.6.1 from its official images, the mail
// gateway, a test inbox and one public router. Run through ../apply.sh,
// which reads the secrets from the macOS Keychain into SD_* variables so they
// never sit in this file or in the repo.

const APPWRITE = "appwrite/appwrite:2.6.1";
const REGION = { "europe-west4-drams3a": 1 };

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

  const postgresData = volume("postgresql-data");
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

  const redisData = volume("redis-data");
  const redis = service("redis", {
    source: image("redis:7.4.7-alpine"),
    start: "redis-server --maxmemory 512mb --maxmemory-policy allkeys-lru --maxmemory-samples 5",
    replicas: REGION,
    volumeMounts: { "redis-data": { mountPath: "/data" } },
  });

  const clickhouseData = volume("clickhouse-data");
  const clickhouse = service("clickhouse", {
    source: empty(), // built from infra/railway/clickhouse with `railway up`
    replicas: REGION,
    volumeMounts: { "clickhouse-data": { mountPath: "/var/lib/clickhouse" } },
    env: {
      CLICKHOUSE_DB: "appwrite",
      CLICKHOUSE_USER: "appwrite",
      CLICKHOUSE_PASSWORD: secret("SD_USAGE_PASS"),
      CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: "1",
      CLICKHOUSE_ALWAYS_RUN_INITDB_SCRIPTS: "1",
    },
  });

  const geo = service("appwrite-geo", { source: image("appwrite/geo:0.3.2"), replicas: REGION });

  const console_ = service("appwrite-console", {
    source: image("appwrite/new:1.2.97-self-hosted"),
    replicas: REGION,
    env: { PORT: "3000", VITE_APPWRITE_VERSION: "2.6.1" },
  });

  const gatewayData = volume("mail-gateway-data");
  const mailGateway = service("mail-gateway", {
    source: empty(), // built from infra/mail-gateway with `railway up`
    replicas: REGION,
    volumeMounts: { "mail-gateway-data": { mountPath: "/data" } },
    env: {
      GATEWAY_MASTER_KEY: secret("SD_MAIL_MASTER_KEY"),
      DELIVERY: process.env.SD_MAIL_DELIVERY ?? "smtp",
      MAIL_DAILY_LIMIT: "1000",
      MAIL_APP_DAILY_LIMIT: "300",
      MAIL_APP_NEWS_DAILY_LIMIT: "500",
      MAIL_NEWS_SHARE_PERCENT: "70",
      SENDER_DOMAINS: "apps.ludvighedin.com",
      FORWARD_HOST: "mailpit.railway.internal",
      FORWARD_PORT: "1025",
    },
  });

  // Test inbox until Amazon SES is set up: reachable only through the router
  // at /_mail, behind a password.
  const mailpit = service("mailpit", {
    source: image("axllent/mailpit:v1.29"),
    replicas: REGION,
    env: { MP_WEBROOT: "/_mail/", MP_UI_AUTH: secret("SD_MAILPIT_AUTH"), MP_MAX_MESSAGES: "500" },
  });

  const router = service("router", {
    source: empty(), // built from infra/railway/router with `railway up`
    replicas: REGION,
    healthcheck: "/health",
    domains: [],
  });

  return project("sitedock", {
    resources: [
      files,
      postgresData,
      postgresql,
      redisData,
      redis,
      clickhouseData,
      clickhouse,
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
      mailpit,
      router,
    ],
  });
});
