import { expect, test } from "bun:test";
import { ensureAnalytics } from "../src/analytics";

test("provisioning reuses the same website across retries and address changes", async () => {
  let website: { id: string; name: string; domain: string } | undefined;
  let creates = 0;
  const request = async (url: string, init?: RequestInit) => {
    const { pathname } = new URL(url);
    expect(new URL(url).origin).toBe("https://metrics.example");
    if (pathname === "/api/auth/login") {
      expect(JSON.parse(String(init?.body))).toEqual({ username: "fixture", password: "test-password" });
      return Response.json({ token: "test-token", user: { role: "user" } });
    }
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
    if (pathname === "/api/websites") {
      creates++;
      website = JSON.parse(String(init?.body));
      return Response.json(website);
    }
    if (!website) return Response.json(null);
    expect(pathname).toBe(`/api/websites/${website.id}`);
    if (init?.method === "POST") website = { ...website, ...JSON.parse(String(init.body)) };
    return Response.json(website);
  };
  const options = {
    origin: "https://metrics.example", request,
    credentials: { username: "fixture", password: "test-password", ingestSecret: "f".repeat(64) },
  };
  const first = await ensureAnalytics("todo", "todo.runport.app", options);
  const second = await ensureAnalytics("todo", "todo.example.com", options);
  expect(second).toEqual(first);
  expect(second.ANALYTICS_SITE_ID).toMatch(/^[0-9a-f-]{36}$/);
  expect(second.ANALYTICS_INGEST_TOKEN).toMatch(/^[0-9a-f]{64}$/);
  expect(website?.domain).toBe("todo.example.com");
  expect(creates).toBe(1);
});

test("a custom origin requires its own login and cannot fall back to the default credential", async () => {
  await expect(ensureAnalytics("todo", undefined, {
    origin: "https://other.example",
    credentials: { username: "", password: "", ingestSecret: "" },
    request: async () => { throw new Error("Provisioning must never contact this origin"); },
  })).rejects.toThrow("requires explicit provisioning credentials");
});
