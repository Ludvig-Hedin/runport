import { isIP } from "node:net";
import { analyticsPolicy, analyticsRoute } from "./analytics-policy";

const SITE_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_EVENT_BYTES = 16_384;

export function analyticsConfig() {
  const environment = process.env.RAILWAY_ENVIRONMENT_NAME;
  const { ANALYTICS_URL: url, ANALYTICS_SITE_ID: siteId, ANALYTICS_INGEST_TOKEN: ingestToken } = process.env;
  if (process.env.NODE_ENV !== "production" || (environment && environment !== "production") ||
      !url || !siteId || !SITE_ID.test(siteId) || !ingestToken || !/^[a-f0-9]{64}$/.test(ingestToken)) return null;
  const origin = URL.parse(url);
  if (!origin || origin.protocol !== "https:" || origin.href !== `${origin.origin}/`) return null;
  return { origin: origin.origin, siteId, ingestToken };
}

export function trackingDisabled(headers: Pick<Headers, "get">) {
  return headers.get("dnt") === "1" || headers.get("sec-gpc") === "1";
}

function forwardHeaders(request: Request, names: string[]) {
  const headers = new Headers();
  for (const name of names) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

async function readEvent(request: Request) {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return JSON.parse(body + decoder.decode()) as {
        type?: unknown;
        payload?: Record<string, unknown>;
      } | null;
      bytes += value.byteLength;
      if (bytes > MAX_EVENT_BYTES) {
        void reader.cancel().catch(() => {});
        return null;
      }
      body += decoder.decode(value, { stream: true });
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

export async function collectEvent(request: Request): Promise<Response> {
  const analytics = analyticsConfig();
  if (!analytics) return new Response(null, { status: 404 });
  if (trackingDisabled(request.headers)) return new Response(null, { status: 204 });

  const event = await readEvent(request);
  const payload = event?.payload;
  if (event?.type !== "event" || !payload || payload.website !== analytics.siteId) {
    return new Response(null, { status: 400 });
  }

  // Keep paths, strip query strings, fragments and any credentials. The
  // tracker already strips search and hashes, but custom events can set URLs.
  const app = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? app.host;
  const browserOrigin = request.headers.get("origin");
  const site = browserOrigin ? URL.parse(browserOrigin) : URL.parse(`${app.protocol}//${host}`);
  if (!site || site.host !== host) return new Response(null, { status: 400 });
  const page = typeof payload.url === "string" ? URL.parse(payload.url, site) : null;
  if (!page || page.origin !== site.origin) return new Response(null, { status: 400 });
  const route = analyticsRoute(page.pathname);
  if (!route) return new Response(null, { status: 204 });

  const name = payload.name;
  if (name !== undefined && (typeof name !== "string" || !Object.hasOwn(analyticsPolicy.events, name))) {
    return new Response(null, { status: 204 });
  }
  const fields = typeof name === "string" ? analyticsPolicy.events[name] : undefined;
  const data = payload.data && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
  const eventData = fields && Object.fromEntries(Object.entries(fields).flatMap(([key, values]) =>
    values.some(value => value === data[key]) ? [[key, data[key]]] : [],
  ));
  const referrer = typeof payload.referrer === "string" && payload.referrer ? URL.parse(payload.referrer, page) : null;
  let referrerUrl: string | undefined;
  if (referrer?.origin === site.origin) {
    const referrerRoute = analyticsRoute(referrer.pathname);
    if (referrerRoute) referrerUrl = `${site.origin}${referrerRoute}`;
  } else if (referrer && ["https:", "http:"].includes(referrer.protocol)) {
    referrerUrl = referrer.origin;
  }
  const body = JSON.stringify({
    type: "event",
    payload: {
      website: analytics.siteId,
      url: `${page.origin}${route}`,
      hostname: page.hostname,
      referrer: referrerUrl,
      name,
      data: eventData,
    },
  });
  const headers = forwardHeaders(request, ["user-agent", "x-umami-cache"]);
  headers.set("content-type", "application/json");
  headers.set("authorization", `Bearer ${analytics.ingestToken}`);
  // Railway's public edge supplies X-Real-IP. Ignore forwarding chains and
  // any values from a deployment that is not hosted on Railway.
  const ip = request.headers.get("x-real-ip")?.trim();
  if (process.env.RAILWAY_SERVICE_ID && ip && isIP(ip)) headers.set("x-runport-visitor-ip", ip);
  return proxyAnalytics(analytics.origin + "/runport/ingest", {
    method: "POST", body, headers, cache: "no-store",
  });
}

export async function proxyAnalytics(url: string, init: RequestInit, maxAge?: number) {
  try {
    const upstream = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(5_000) });
    const headers = new Headers({
      "cache-control": maxAge && upstream.ok ? `private, max-age=${maxAge}` : "no-store",
      "x-content-type-options": "nosniff",
    });
    const contentType = upstream.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch {
    return new Response(null, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
