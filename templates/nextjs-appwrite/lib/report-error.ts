import "server-only";
import type { errorReport } from "./error-shape";

type Report = Awaited<ReturnType<typeof errorReport>>;

export function errorReportingEnabled(): boolean {
  return Boolean(process.env.RUNPORT_ERROR_URL && process.env.RUNPORT_ERROR_TOKEN);
}

export async function sendErrorReport(report: Report): Promise<void> {
  const url = process.env.RUNPORT_ERROR_URL;
  const token = process.env.RUNPORT_ERROR_TOKEN;
  if (!url || !token) return;
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(report),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(1500),
  }).catch(() => null);
  if (response?.ok) {
    console.log(JSON.stringify({ event: "runport-error-report", source: report.source, kind: report.kind }));
  }
}
