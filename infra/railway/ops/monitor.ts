import { processAppAlerts } from "./app-alert-monitor";
import { analyticsOwnerAlert, updateIncident, type MonitorState } from "./monitor-alerts";
import { maintainAccounts } from "./account-maintenance";

// Every few minutes: is the API up, is the mail gateway up, and is last
// night's backup there? Emails the owner when something is wrong, at most
// once every ALERT_EVERY_HOURS per problem, and once when it recovers.

const ALERT_EVERY_MS = Number(process.env.ALERT_EVERY_HOURS ?? 3) * 60 * 60 * 1000;
const STATE_KEY = "monitor/state.json";

async function ok(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return res.ok ? null : `answered ${res.status}`;
  } catch (error) {
    return (error as Error).message;
  }
}

async function checkPlatform() {
  const { alertOwner, bucket } = await import("./shared");

  async function backupFresh(kind: "appwrite" | "git" | "analytics"): Promise<string | null> {
    const listed = await bucket.list({ prefix: `backups/${kind}-` });
    const newest = (listed.contents ?? []).map((o) => Date.parse(String(o.lastModified))).sort((a, b) => a - b).at(-1);
    if (!newest) return "no backup found";
    const hours = (Date.now() - newest) / 3_600_000;
    return hours > 30 ? `newest backup is ${Math.round(hours)} hours old` : null;
  }

  const checks: Record<string, () => Promise<string | null>> = {
    "Appwrite API": () => ok("http://appwrite.railway.internal/v1/health/version"),
    "Mail gateway": () => ok("http://mail-gateway.railway.internal:8080/health"),
    "Nightly backup": () => backupFresh("appwrite"),
  };
  if (process.env.GIT_HEALTH_URL) {
    checks["Nightly Git backup"] = () => backupFresh("git");
    // The nightly snapshot briefly stops Forgejo while copying the volume.
    const now = new Date();
    if (now.getUTCHours() !== 1 || now.getUTCMinutes() >= 10) {
      const url = process.env.GIT_HEALTH_URL;
      checks["Runport Git"] = () => ok(url);
    }
  }

  const analyticsHealthUrl = process.env.ANALYTICS_HEALTH_URL;
  const analyticsChecks = new Set(["Analytics service", "Analytics backup"]);
  if (analyticsHealthUrl) {
    checks["Analytics service"] = () => ok(analyticsHealthUrl);
    checks["Analytics backup"] = () => backupFresh("analytics");
  }

  const stateFile = bucket.file(STATE_KEY);
  const state: MonitorState = (await stateFile.exists()) ? await stateFile.json() : {};
  const now = Date.now();
  for (const [name, check] of Object.entries(checks)) {
    const problem = await check().catch((e: Error) => e.message);
    const known = state[name];
    const analytics = analyticsChecks.has(name);
    const send = analytics ? analyticsOwnerAlert(process.env.ALERT_TO, alertOwner) : alertOwner;
    await updateIncident(state, name, problem, now, analytics ? Infinity : ALERT_EVERY_MS, send)
      .catch((error: Error) => {
        console.error(JSON.stringify({ check: name, result: "alert failed", problem: error.message }));
      });
    if (problem) console.log(JSON.stringify({ check: name, result: "failing", problem }));
    else if (analytics) console.log(JSON.stringify({ check: name, result: known ? "recovered" : "ok" }));
  }
  await stateFile.write(JSON.stringify(state));
}

const jobs = [{ name: "platform monitor", run: checkPlatform() }];
if (process.env.RUNPORT_ALERT_MONITOR_KEY) {
  jobs.push({ name: "app alerts", run: processAppAlerts() });
}

if (process.env.RUNPORT_ALERT_MONITOR_KEY) {
  jobs.push({ name: "account maintenance", run: maintainAccounts() });
}

const results = await Promise.allSettled(jobs.map(job => job.run));
for (const [index, result] of results.entries()) {
  if (result.status === "rejected") {
    const problem = result.reason instanceof Error ? result.reason.message : String(result.reason);
    console.error(JSON.stringify({ check: jobs[index].name, result: "check failed", problem }));
    process.exitCode = 1;
  }
}
