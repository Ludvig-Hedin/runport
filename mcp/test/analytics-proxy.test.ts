import { afterEach, beforeEach, expect, test } from "bun:test";
import { collectEvent } from "../../templates/nextjs-appwrite/lib/analytics-server";
import { analyticsPolicy, analyticsRoute } from "../../templates/nextjs-appwrite/lib/analytics-policy";

const id = "765ce531-050d-4bf6-b61e-dcdb1d46e564";
const endpoint = "https://test.example/runport-metrics/api/send";
const env = {
  NODE_ENV: "production",
  RAILWAY_ENVIRONMENT_NAME: "production",
  RAILWAY_SERVICE_ID: "test-service",
  ANALYTICS_URL: "https://metrics.example",
  ANALYTICS_SITE_ID: id,
  ANALYTICS_INGEST_TOKEN: "b".repeat(64),
};
const keys = Object.keys(env);
const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

beforeEach(() => Object.assign(process.env, env));
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of keys) {
    if (prior[key] === undefined) delete process.env[key];
    else process.env[key] = prior[key];
  }
});

function request(headers: HeadersInit = {}, siteId = id) {
  return new Request(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "event",
      payload: {
        website: siteId,
        url: "https://test.example/items?token=private#secret",
        referrer: "https://example.net/private-path?email=private",
        title: "Private page title",
        id: "private-user-id",
      },
    }),
  });
}

test("analytics omits cookies and identifying fields when forwarding a pageview", async () => {
  globalThis.fetch = Object.assign(async (url: unknown, options?: RequestInit) => {
    expect(url).toBe("https://metrics.example/runport/ingest");
    const headers = new Headers(options?.headers);
    expect(headers.has("cookie")).toBe(false);
    expect(headers.get("authorization")).toBe(`Bearer ${env.ANALYTICS_INGEST_TOKEN}`);
    expect(headers.get("x-runport-visitor-ip")).toBe("192.0.2.4");
    expect(JSON.parse(String(options?.body))).toEqual({
      type: "event",
      payload: { website: id, url: "https://test.example/items", referrer: "https://example.net", hostname: "test.example" },
    });
    return Response.json({ cache: "test-token" }, { headers: { "Set-Cookie": "unexpected=1" } });
  }, { preconnect: originalFetch.preconnect });

  const response = await collectEvent(request({
    cookie: "session=private",
    authorization: "Bearer private",
    "x-real-ip": "192.0.2.4",
    "x-forwarded-for": "198.51.100.1",
  }));
  expect(response.status).toBe(200);
  expect(response.headers.has("set-cookie")).toBe(false);
});

test("unknown paths stay out of analytics", () => {
  expect(analyticsRoute("/items")).toBe("/items");
  expect(analyticsRoute("/items/private-identifier")).toBeUndefined();
  expect(analyticsRoute("/reset")).toBeUndefined();
  expect(analyticsRoute("/items/private-identifier", ["/items/[id]"])).toBe("/items/[id]");
});

test("custom events only forward enumerated fields and values", async () => {
  const events = analyticsPolicy.events;
  Object.assign(events, { filter: { selection: ["open"], mode: ["all"] } });
  try {
    const req = new Request(endpoint, {
      method: "POST",
      body: JSON.stringify({ type: "event", payload: {
        website: id, url: "/items", name: "filter",
        data: { selection: "open", mode: "private", email: "private@example.net" },
      } }),
      headers: { "x-real-ip": "192.0.2.4, 192.0.2.5", "x-forwarded-for": "192.0.2.6" },
    });
    globalThis.fetch = Object.assign(async (_url: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).payload.data).toEqual({ selection: "open" });
      expect(new Headers(init?.headers).has("x-runport-visitor-ip")).toBe(false);
      return Response.json({});
    }, { preconnect: originalFetch.preconnect });
    expect((await collectEvent(req)).status).toBe(200);
  } finally {
    Reflect.deleteProperty(events, "filter");
  }
});

test("privacy preferences, previews and other website IDs never reach Umami", async () => {
  globalThis.fetch = Object.assign(async () => {
    throw new Error("Analytics should not be forwarded.");
  }, { preconnect: originalFetch.preconnect });

  expect((await collectEvent(request({ dnt: "1" }))).status).toBe(204);
  expect((await collectEvent(request({ "sec-gpc": "1" }))).status).toBe(204);
  expect((await collectEvent(request({}, "987db494-0266-48b8-849c-4a67ef8248fa"))).status).toBe(400);
  expect((await collectEvent(request({ origin: "https://other.example" }))).status).toBe(400);
  process.env.RAILWAY_ENVIRONMENT_NAME = "preview";
  expect((await collectEvent(request())).status).toBe(404);
});
