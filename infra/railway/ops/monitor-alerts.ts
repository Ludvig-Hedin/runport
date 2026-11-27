type Incident = { failingSince: number; lastAlert: number };
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
): Promise<void> {
  const known = state[name];
  if (problem) {
    const entry = known ?? { failingSince: now, lastAlert: 0 };
    if (send && (!entry.lastAlert || now - entry.lastAlert >= repeatAfterMs)) {
      await send(`Runport: ${name} is down`, `${name}: ${problem}\nFailing since ${new Date(entry.failingSince).toISOString()}.\n`);
      entry.lastAlert = now;
    }
    state[name] = entry;
  } else if (known) {
    if (known.lastAlert && send) await send(`Runport: ${name} is back`, `${name} works again.\n`);
    delete state[name];
  }
}
