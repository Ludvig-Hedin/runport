import { errorReport } from "./lib/error-shape";

const sent = new Set<string>();

async function report(error: unknown, location?: string) {
  const known = error instanceof Error ? error : undefined;
  const event = await errorReport("browser", known?.name, known?.stack ?? location, "", window.location.origin);
  if (sent.has(event.fingerprint) || sent.size >= 5) return;
  sent.add(event.fingerprint);
  await fetch("/api/runport/error", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
    credentials: "same-origin",
    keepalive: true,
  });
}

window.addEventListener("error", (event) => {
  if (!(event instanceof ErrorEvent)) return;
  const location = event.filename ? `at ${event.filename}:${event.lineno}:${event.colno}` : undefined;
  void report(event.error, location).catch(() => {});
});

window.addEventListener("unhandledrejection", (event) => {
  void report(event.reason).catch(() => {});
});
