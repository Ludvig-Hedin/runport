type Incident = { failingSince: number; lastDeliveredAt?: number; lastAlert?: number };
export type MonitorState = Record<string, Incident>;
type SendAlert = (subject: string, text: string) => Promise<void>;

export function analyticsOwnerAlert(recipient: string | undefined, send: SendAlert): SendAlert | undefined {
  return recipient === "ludvig@ludvighedin.com" ? send : undefined;
}

export async function updateIncident(
  state: MonitorState,
  name: string,
  problem: string | null,
  now: number,
  repeatAfterMs: number,
  send?: SendAlert,
  legacyLogOnly = false,
): Promise<void> {
  const known = state[name];
  if (!problem && !known) return;
  const entry: Incident = {
    failingSince: known?.failingSince ?? now,
    // The first analytics monitor recorded its log time in lastAlert.
    // Preserve the original failure time and require real send evidence.
    lastDeliveredAt: known?.lastDeliveredAt ?? (legacyLogOnly ? undefined : known?.lastAlert),
  };
  state[name] = entry;
  if (problem) {
    // The cron cadence governs retries of unconfirmed sends. The reminder
    // throttle starts only when the Worker confirms a send.
    if (send && (!entry.lastDeliveredAt || now - entry.lastDeliveredAt >= repeatAfterMs)) {
      await send(`Runport: ${name} is down`, `${name}: ${problem}\nFailing since ${new Date(entry.failingSince).toISOString()}.\n`);
      entry.lastDeliveredAt = now;
    }
  } else {
    if (entry.lastDeliveredAt && send) await send(`Runport: ${name} is back`, `${name} works again.\n`);
    delete state[name];
  }
}
