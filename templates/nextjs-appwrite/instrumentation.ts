import type { Instrumentation } from "next";
import { errorReport } from "./lib/error-shape";
import { errorReportingEnabled, sendErrorReport } from "./lib/report-error";

export const onRequestError: Instrumentation.onRequestError = async (error, _request, context) => {
  if (!errorReportingEnabled()) return;
  try {
    const known = error instanceof Error ? error : undefined;
    await sendErrorReport(await errorReport(context.routeType, known?.name, known?.stack, context.routePath));
  } catch {
    // Reporting must leave Next's original error handling intact.
  }
};
