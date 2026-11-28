import { analyticsConfig, proxyAnalytics, trackingDisabled } from "@/lib/analytics-server";

export async function GET(request: Request) {
  const analytics = analyticsConfig();
  if (!analytics) return new Response(null, { status: 404 });
  if (trackingDisabled(request.headers)) return new Response(null, { status: 204 });
  return proxyAnalytics(analytics.origin + "/script.js", { cache: "force-cache", next: { revalidate: 300 } }, 300);
}
