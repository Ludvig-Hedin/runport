import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

const siteId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const allowedApi = new Set([
  "2fa", "admin", "auth", "batch", "boards", "dashboard", "heartbeat", "links",
  "me", "pixels", "realtime", "share", "teams", "users", "websites",
]);
const maxEventBytes = 16_384;
const dashboardHeaders = [
  "accept", "accept-language", "authorization", "content-type", "cookie", "origin",
  "user-agent", "rsc", "next-router-state-tree", "next-router-prefetch",
  "next-router-segment-prefetch", "x-umami-share-token", "x-umami-share-context",
];

type Options = {
  secret: string;
  upstream: string;
  ready: () => Promise<boolean>;
  request?: (url: string, options: RequestInit) => Promise<Response>;
};

function selectHeaders(request: Request, names: string[]) {
  const headers = new Headers();
  for (const name of names) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

export function analyticsGateway({ secret, upstream, ready, request = fetch }: Options) {
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error("ANALYTICS_INGEST_SECRET must be 32 random bytes as hex.");

  async function forward(path: string, init: RequestInit) {
    try {
      const response = await request(upstream + path, {
        ...init, redirect: "manual", signal: AbortSignal.timeout(10_000),
      });
      const headers = new Headers(response.headers);
      for (const header of ["connection", "content-encoding", "content-length", "transfer-encoding", "x-middleware-rewrite"]) {
        headers.delete(header);
      }
      const location = headers.get("location");
      if (location?.startsWith(upstream + "/")) headers.set("location", location.slice(upstream.length));
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return new Response(null, { status: 502 });
    }
  }

  return async (incoming: Request) => {
    const { pathname, search } = new URL(incoming.url);
    const [, root, api] = pathname.split("/");
    const reading = incoming.method === "GET" || incoming.method === "HEAD";
    if (reading && (pathname === "/runport/health" || pathname === "/runport/ingest")) {
      return new Response(null, { status: await ready().catch(() => false) ? 204 : 503, headers: { "cache-control": "no-store" } });
    }
    if (pathname === "/runport/ingest" && incoming.method === "POST") {
      const credential = incoming.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      if (!credential) return new Response(null, { status: 403 });
      const body = await incoming.text().catch(() => "");
      if (Buffer.byteLength(body) > maxEventBytes) return new Response(null, { status: 413 });
      let event: { type?: unknown; payload?: { website?: unknown } } | null;
      try { event = JSON.parse(body); } catch { return new Response(null, { status: 400 }); }
      const id = event?.payload?.website;
      if (event?.type !== "event" || typeof id !== "string" || !siteId.test(id)) {
        return new Response(null, { status: 400 });
      }
      const expected = createHmac("sha256", secret).update(`runport:analytics:ingest:v1:${id}`).digest();
      if (!timingSafeEqual(Buffer.from(credential, "hex"), expected)) return new Response(null, { status: 403 });
      const headers = selectHeaders(incoming, ["user-agent", "x-umami-cache"]);
      const ip = incoming.headers.get("x-runport-visitor-ip");
      if (ip && isIP(ip)) headers.set("x-runport-visitor-ip", ip);
      headers.set("content-type", "application/json");
      return forward("/api/send", { method: "POST", body, headers });
    }
    // Umami is reachable publicly only through these dashboard and asset
    // routes. Collection, pixels, replay, and alternate API namespaces stay private.
    if (!/^[a-zA-Z0-9_./-]+$/.test(pathname) || pathname.includes("//") ||
        ["p", "q", "compat", "runport", "mcp"].includes(root ?? "") ||
        (root === "api" ? !allowedApi.has(api ?? "") : !reading)) {
      return new Response(null, { status: 404 });
    }
    return forward(pathname + search, {
      method: incoming.method,
      headers: selectHeaders(incoming, dashboardHeaders),
      body: reading ? undefined : await incoming.arrayBuffer(),
    });
  };
}
