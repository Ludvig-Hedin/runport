import { alertOwner, bucket } from "./shared";

// Every few minutes: is the API up, is the mail gateway up, and is last
// night's backup there? Emails the owner when something is wrong, at most
// once every ALERT_EVERY_HOURS per problem, and once when it recovers.

const ALERT_EVERY_MS = Number(process.env.ALERT_EVERY_HOURS ?? 3) * 60 * 60 * 1000;
const STATE_KEY = "monitor/state.json";

type State = Record<string, { failingSince: number; lastAlert: number }>;

async function ok(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return res.ok ? null : `answered ${res.status}`;
  } catch (error) {
    return (error as Error).message;
  }
}

async function backupFresh(): Promise<string | null> {
  const listed = await bucket.list({ prefix: "backups/" });
  const newest = (listed.contents ?? []).map((o) => Date.parse(String(o.lastModified))).sort().at(-1);
  if (!newest) return "no backup found";
  const hours = (Date.now() - newest) / 3_600_000;
  return hours > 30 ? `newest backup is ${Math.round(hours)} hours old` : null;
}

const checks: Record<string, () => Promise<string | null>> = {
  "Appwrite API": () => ok("http://appwrite.railway.internal/v1/health/version"),
  "Mail gateway": () => ok("http://mail-gateway.railway.internal:8080/health"),
  "Nightly backup": backupFresh,
};

const stateFile = bucket.file(STATE_KEY);
const state: State = (await stateFile.exists()) ? await stateFile.json() : {};
const now = Date.now();
for (const [name, check] of Object.entries(checks)) {
  const problem = await check().catch((e: Error) => e.message);
  const known = state[name];
  if (problem) {
    const entry = known ?? { failingSince: now, lastAlert: 0 };
    if (now - entry.lastAlert >= ALERT_EVERY_MS) {
      await alertOwner(`Runport: ${name} is down`, `${name}: ${problem}\nFailing since ${new Date(entry.failingSince).toISOString()}.\n`);
      entry.lastAlert = now;
    }
    state[name] = entry;
    console.log(JSON.stringify({ check: name, result: "failing", problem }));
  } else if (known) {
    if (known.lastAlert) await alertOwner(`Runport: ${name} is back`, `${name} works again.\n`);
    delete state[name];
  }
}
await stateFile.write(JSON.stringify(state));
