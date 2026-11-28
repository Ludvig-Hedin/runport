import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureAnalytics } from "./analytics";

export async function provisionAppAnalytics(folder: string, slug: string, domain?: string) {
  const [layout, server, ...sources] = await Promise.all([
    "app/layout.tsx",
    "lib/analytics-server.ts",
    "lib/analytics-policy.ts",
    "app/visitor-analytics.tsx",
    "app/runport-metrics/tracker.js/route.ts",
    "app/runport-metrics/api/send/route.ts",
  ].map(path => readFile(join(folder, path), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  })));
  if (!/<VisitorAnalytics(?:\s|\/|>)/.test(layout ?? "") || sources.some(source => !source) ||
      !server?.includes("ANALYTICS_INGEST_TOKEN")) {
    return {
      variables: {},
      note: "Visitor analytics skipped. Follow the existing apps upgrade instructions in Runport's Railway README, then redeploy.",
    };
  }
  const variables = await ensureAnalytics(slug, domain);
  return {
    variables,
    note: variables.ANALYTICS_SITE_ID ? "Configured visitor analytics." : "Visitor analytics is unavailable for this Runport installation.",
  };
}
