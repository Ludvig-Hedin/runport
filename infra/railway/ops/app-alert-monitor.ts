export async function processAppAlerts(env = process.env, request = fetch): Promise<void> {
  const key = env.RUNPORT_ALERT_MONITOR_KEY;
  if (!key) throw new Error("App alerts monitor needs RUNPORT_ALERT_MONITOR_KEY.");
  const url = env.RUNPORT_ALERT_MONITOR_URL ?? "http://mail-gateway.railway.internal:8080/internal/app-alerts";
  const response = await request(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ processRailwayEvents: true }),
    redirect: "error", signal: AbortSignal.timeout(65_000),
  });
  if (!response.ok) throw new Error(`Could not process app alerts (${response.status}).`);
  const processed = response.headers.get("X-Runport-Railway-Events-Processed") ?? "0";
  console.log(JSON.stringify({ check: "app alerts", railwayEventsProcessed: /^\d+$/.test(processed) ? Number(processed) : 0 }));
  const failed = response.headers.get("X-Runport-Alert-Delivery-Failures");
  if (failed && /^[1-9]\d*$/.test(failed)) {
    throw new Error(`Owner alert delivery failed for ${failed} retained alert(s). See the mail gateway logs.`);
  }
}

if (import.meta.main) await processAppAlerts();
