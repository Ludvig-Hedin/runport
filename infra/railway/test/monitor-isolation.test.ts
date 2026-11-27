import { expect, test } from "bun:test";
import { join } from "node:path";

test.each(["read", "write"] as const)("a platform state %s failure still runs app alerts", async (failure) => {
  const calls: string[] = [];
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      calls.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/internal/app-alerts") {
        if (request.method === "GET") return Response.json({ apps: [] });
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith("/monitor/state.json")) {
        if (failure === "write" && request.method === "HEAD") return new Response(null, { status: 404 });
        return new Response("<Error><Code>ServiceUnavailable</Code></Error>", { status: 503 });
      }
      if (url.searchParams.has("list-type")) {
        return new Response(`<ListBucketResult><IsTruncated>false</IsTruncated><Contents>
          <Key>backups/appwrite-fixture.dump</Key><LastModified>${new Date().toISOString()}</LastModified><Size>1</Size>
        </Contents></ListBucketResult>`, { headers: { "Content-Type": "application/xml" } });
      }
      return new Response(null, { status: 404 });
    },
  });
  const probes = `globalThis.fetch = ((real) => (url, options) => {
    if (String(url).startsWith(${JSON.stringify(server.url.origin)} + "/")) return real(url, options);
    if (String(url).includes(".railway.internal/") || String(url).includes(".railway.internal:8080/"))
      return Promise.resolve(new Response("ok"));
    throw new Error("Unexpected outbound request in the isolated monitor test");
  })(fetch);
  await import(${JSON.stringify(join(import.meta.dir, "../ops/monitor.ts"))});`;
  const job = Bun.spawn([process.execPath, "-e", probes], {
    env: {
      S3_ACCESS_KEY_ID: "fixture-key", S3_SECRET_ACCESS_KEY: "fixture-secret", S3_BUCKET: "fixture-bucket",
      S3_REGION: "us-east-1", S3_ENDPOINT: server.url.origin,
      RUNPORT_ALERT_MONITOR_KEY: "fixture-monitor-key", RAILWAY_MONITOR_TOKEN: "fixture-railway-token",
      RUNPORT_ALERT_MONITOR_URL: new URL("/internal/app-alerts", server.url).href,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(job.stdout).text(), new Response(job.stderr).text(), job.exited]);
  expect(code).toBe(1);
  expect(err).toContain('"check":"platform monitor"');
  expect(calls.some(call => call.startsWith(failure === "read" ? "HEAD " : "PUT ") && call.endsWith("/monitor/state.json"))).toBe(true);
  expect(calls).toContain("POST /internal/app-alerts");
  expect(out).toContain('"check":"app alerts"');
}, 15_000);
