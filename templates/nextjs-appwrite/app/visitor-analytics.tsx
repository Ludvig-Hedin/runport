import { cookies, headers } from "next/headers";
import Script from "next/script";
import { analyticsConfig, trackingDisabled } from "@/lib/analytics-server";
import { sitePassword } from "@/lib/config";
import { safeEqual, unlockCookieName, unlockToken } from "@/lib/site-lock";

export async function VisitorAnalytics() {
  const analytics = analyticsConfig();
  if (!analytics || trackingDisabled(await headers())) return null;

  const password = sitePassword();
  if (password) {
    const cookie = (await cookies()).get(unlockCookieName())?.value;
    if (!cookie || !safeEqual(cookie, await unlockToken(password))) return null;
  }

  return (
    <Script
      src="/runport-metrics/tracker.js"
      data-host-url="/runport-metrics"
      data-website-id={analytics.siteId}
      data-do-not-track="true"
      data-exclude-search="true"
      data-exclude-hash="true"
      data-fetch-credentials={password ? "same-origin" : "omit"}
    />
  );
}
