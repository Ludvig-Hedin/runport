import { expect, test } from "bun:test";
import { processAppAlerts } from "../infra/railway/ops/app-alert-monitor";

test("processes queued Railway alerts using an authenticated POST to the gateway", async () => {
  const url = "https://gateway.example.test/internal/app-alerts";
  await processAppAlerts({ RUNPORT_ALERT_MONITOR_KEY: "fixture", RUNPORT_ALERT_MONITOR_URL: url }, async (input, options) => {
    expect(String(input)).toBe(url);
    expect(options?.method).toBe("POST");
    expect(options?.redirect).toBe("error");
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer fixture");
    expect(JSON.parse(String(options?.body))).toEqual({ processRailwayEvents: true });
    return new Response(null, { status: 204 });
  });
});

test("surfaces gateway failures and retained owner delivery failures", async () => {
  const env = { RUNPORT_ALERT_MONITOR_KEY: "fixture" };
  await expect(processAppAlerts(env, async () => new Response(null, { status: 503 })))
    .rejects.toThrow("Could not process app alerts (503)");
  await expect(processAppAlerts(env, async () => new Response(null, {
    status: 204, headers: { "X-Runport-Alert-Delivery-Failures": "1" },
  }))).rejects.toThrow("Owner alert delivery failed for 1 retained alert");
});
