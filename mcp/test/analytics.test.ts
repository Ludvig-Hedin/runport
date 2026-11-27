import { expect, test } from "bun:test";
import { ensureAnalytics } from "../src/analytics";

test("provisioning reuses the same website across retries and address changes", async () => {
  let website: { id: string; name: string; domain: string } | undefined;
  let creates = 0;
  const request = async (url: string, init?: RequestInit) => {
    const { pathname } = new URL(url);
    expect(new URL(url).origin).toBe("https://metrics.example");
    if (pathname === "/api/auth/login") return Response.json({ token: "test-token" });
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
  const options = { origin: "https://metrics.example", password: async () => "test-password", request };
  const first = await ensureAnalytics("todo", "todo.runport.app", options);
  const second = await ensureAnalytics("todo", "todo.example.com", options);
  expect(second).toEqual(first);
  expect(second.ANALYTICS_SITE_ID).toMatch(/^[0-9a-f-]{36}$/);
  expect(website?.domain).toBe("todo.example.com");
  expect(creates).toBe(1);
});
