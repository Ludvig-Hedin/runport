import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { analyticsGateway } from "../../infra/railway/analytics/gateway";

const a = "765ce531-050d-4bf6-b61e-dcdb1d46e564";
const b = "987db494-0266-48b8-849c-4a67ef8248fa";
const secret = "f".repeat(64);
const token = (id: string) => createHmac("sha256", secret).update(`runport:analytics:ingest:v1:${id}`).digest("hex");

test("a site credential only submits events for that site, and no public path exposes the raw collector", async () => {
  const calls: string[] = [];
  const handle = analyticsGateway({
    secret, upstream: "http://127.0.0.1:3001", ready: async () => true,
    request: async (url, init) => {
      calls.push(url);
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return Response.json({ visitId: "fixture" });
    },
  });
  const event = (site: string, path = "/runport/ingest", credential = token(a)) =>
    new Request("https://analytics.example" + path, {
      method: "POST",
      headers: { authorization: `Bearer ${credential}` },
      body: JSON.stringify({ type: "event", payload: { website: site } }),
    });
  expect((await handle(event(a))).status).toBe(200);
  expect((await handle(event(b))).status).toBe(403);
  expect((await handle(event(a, "/runport/ingest", ""))).status).toBe(403);
  for (const path of ["/api/send", "/api/send/", "/api/%73end", "/api/record", "/p/fixture", "/q/fixture", "/compat/api/send"]) {
    expect((await handle(event(a, path))).status).toBe(404);
  }
  expect(calls).toEqual(["http://127.0.0.1:3001/api/send"]);
});

test("public readiness exposes backend health without submitting events", async () => {
  const handle = analyticsGateway({
    secret, upstream: "http://127.0.0.1:3001", ready: async () => false,
    request: async () => { throw new Error("Readiness must not submit an event"); },
  });
  expect((await handle(new Request("https://analytics.example/runport/ingest"))).status).toBe(503);
});
