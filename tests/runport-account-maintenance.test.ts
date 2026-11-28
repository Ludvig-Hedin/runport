import { expect, test } from "bun:test";
import { maintainAccounts } from "../infra/railway/ops/account-maintenance";
import { authorisedMaintenance } from "../templates/nextjs-appwrite/lib/account-maintenance";

test("maintenance makes bounded, authenticated POSTs to all pages and never follows redirects", async () => {
  const app = { slug: "first-app", serviceId: "service-one", environmentId: "production", domain: "first.up.railway.app" };
  const valid = { ...app, slug: "last-app", domain: "last.up.railway.app" };
  const invalid = { ...app, slug: "invalid-app", domain: "last.up.railway.app@example.test" };
  const probes: Array<{ domain: string; options?: RequestInit }> = [];
  const listing: string[] = [];
  const run = () => maintainAccounts({ RUNPORT_ALERT_MONITOR_KEY: "fixture" }, async (input, options) => {
    const url = new URL(String(input));
    if (url.pathname === "/internal/app-alerts") {
      const after = url.searchParams.get("accountMaintenanceAfter");
      listing.push(after ?? "missing");
      return after ? Response.json({ apps: [valid], next: null }) : Response.json({ apps: [app, invalid], next: "invalid-app" });
    }
    probes.push({ domain: url.hostname, options });
    return new Response(null, { status: url.hostname === app.domain ? 503 : 204 });
  });
  await expect(run()).rejects.toThrow("2 app account maintenance probes failed");
  expect(listing).toEqual(["", "invalid-app"]);
  expect(probes.map(({ domain }) => domain)).toEqual([app.domain, valid.domain]);
  for (const { options } of probes) {
    expect(options?.method).toBe("POST");
    expect(options?.redirect).toBe("error");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  }
  const keys = probes.map(({ options }) => new Headers(options?.headers).get("authorization"));
  expect(keys[0]).toMatch(/^Bearer [a-f0-9]{64}$/);
  expect(keys[0]).not.toBe(keys[1]);
  expect(authorisedMaintenance(keys[0], keys[0]?.slice(7))).toBe(true);
  expect(authorisedMaintenance(keys[0], "fixture")).toBe(false);
});
