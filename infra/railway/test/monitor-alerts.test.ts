import { expect, test } from "bun:test";
import { analyticsOwnerAlert, updateIncident, type MonitorState } from "../ops/monitor-alerts";

test("analytics downtime and stale backups each email once per incident and once on recovery", async () => {
  const state: MonitorState = {};
  const subjects: string[] = [];
  const send = analyticsOwnerAlert("ludvig@ludvighedin.com", async subject => { subjects.push(subject); });
  for (const [check, reason] of [["Analytics service", "answered 503"], ["Analytics backup", "newest backup is 31 hours old"]] as const) {
    await updateIncident(state, check, reason, 1, Infinity, send);
    await updateIncident(state, check, reason, 4 * 3_600_000, Infinity, send);
    await updateIncident(state, check, null, 5 * 3_600_000, Infinity, send);
    await updateIncident(state, check, null, 6 * 3_600_000, Infinity, send);
    await updateIncident(state, check, reason, 7 * 3_600_000, Infinity, send);
  }
  expect(subjects).toEqual([
    "Runport: Analytics service is down", "Runport: Analytics service is back", "Runport: Analytics service is down",
    "Runport: Analytics backup is down", "Runport: Analytics backup is back", "Runport: Analytics backup is down",
  ]);
});

test("a log-only incident records no notification or recovery email", async () => {
  const state: MonitorState = {};
  const sent: string[] = [];
  const send = analyticsOwnerAlert("ludvig@ludvighedin.com,other@example.com", async subject => { sent.push(subject); });
  await updateIncident(state, "Analytics service", "failed", 1, Infinity, send);
  await updateIncident(state, "Analytics service", null, 2, Infinity, async subject => { sent.push(subject); });
  expect(sent).toEqual([]);
  expect(state).toEqual({});
});
