import { expect, test } from "bun:test";
import { analyticsOwnerAlert, updateIncident, type MonitorState } from "../ops/monitor-alerts";
import { requireConfirmedDelivery } from "../ops/mail-delivery";

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

test("a legacy analytics log is not delivery evidence", async () => {
  const failure = "Analytics service";
  const stale = "Analytics backup";
  const state: MonitorState = {
    [failure]: { failingSince: 1, lastAlert: 2 },
    [stale]: { failingSince: 1, lastAlert: 2 },
  };
  const subjects: string[] = [];
  const send = async (subject: string) => { subjects.push(subject); };
  await updateIncident(state, failure, "still down", 3, Infinity, send, true);
  await updateIncident(state, stale, null, 3, Infinity, send, true);
  await updateIncident(state, failure, null, 4, Infinity, send, true);
  expect(subjects).toEqual(["Runport: Analytics service is down", "Runport: Analytics service is back"]);
  expect(state).toEqual({});
});

test("HTTP 200 with zero sends leaves the incident retryable and never triggers a recovery alone", async () => {
  const check = "Appwrite API";
  const state: MonitorState = {};
  const subjects: string[] = [];
  const deliver = (sent: number) => async (subject: string) => {
    subjects.push(subject);
    await requireConfirmedDelivery(Response.json({ sent, failed: 1 - sent }));
  };
  await expect(updateIncident(state, check, "failed", 1, 10_800_000, deliver(0))).rejects.toThrow("confirmed");
  const unsent = JSON.parse(JSON.stringify(state)) as MonitorState;
  expect(unsent[check]).toEqual({ failingSince: 1 });
  await updateIncident(state, check, null, 2, 10_800_000, deliver(1));
  await updateIncident(unsent, check, "still down", 300_001, 10_800_000, deliver(1));
  await updateIncident(unsent, check, "still down", 600_001, 10_800_000, deliver(1));
  await updateIncident(unsent, check, null, 900_001, 10_800_000, deliver(1));
  expect(subjects).toEqual(["Runport: Appwrite API is down", "Runport: Appwrite API is down", "Runport: Appwrite API is back"]);
});

test("only a confirmed recovery removes a delivered incident", async () => {
  const check = "Runport Git";
  const state: MonitorState = { [check]: { failingSince: 1, lastDeliveredAt: 2 } };
  for (const response of [new Response("invalid JSON"), Response.json({ sent: 1, failed: 1 })]) {
    await expect(updateIncident(state, check, null, 3, Infinity, () => requireConfirmedDelivery(response)))
      .rejects.toThrow("confirmed");
    expect(state[check]).toEqual({ failingSince: 1, lastDeliveredAt: 2 });
  }
  await updateIncident(state, check, null, 4, Infinity, () => requireConfirmedDelivery(Response.json({ sent: 1, failed: 0 })));
  expect(state).toEqual({});
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
