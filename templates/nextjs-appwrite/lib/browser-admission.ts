import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

const lifetime = 20 * 60_000;

export function browserClient(headers: Headers, railway: boolean): string | undefined {
  if (!railway) return headers.get("host")?.match(/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/)?.[1];
  // Railway's public edge supplies the remote address on production requests.
  const ip = headers.get("x-real-ip");
  return ip && isIP(ip) ? ip : undefined;
}

function signature(key: string, client: string, expiry: number): string {
  return createHmac("sha256", key).update(`runport-browser-grant:${client}:${expiry}`).digest("hex");
}

export function browserGrant(key: string, client: string, now = Date.now()): string {
  const expiry = now + lifetime;
  return `${expiry}.${signature(key, client, expiry)}`;
}

export function createBrowserAdmission() {
  let minute = -1;
  let accepted = 0;
  const visitors = new Map<string, number>();

  return (request: Request, key: string, railway: boolean, now = Date.now()): 204 | 403 | 429 => {
    const host = request.headers.get("host");
    if (!host || request.headers.get("origin") !== `${railway ? "https" : "http"}://${host}`) return 403;
    const client = browserClient(request.headers, railway);
    const fields = request.headers.get("x-runport-error-grant")?.match(/^(\d{1,16})\.([a-f0-9]{64})$/);
    if (!client || !fields) return 403;
    const expiry = Number(fields[1]);
    if (expiry <= now || expiry > now + lifetime) return 403;
    if (!timingSafeEqual(Buffer.from(fields[2]), Buffer.from(signature(key, client, expiry)))) return 403;

    const currentMinute = Math.floor(now / 60_000);
    if (minute !== currentMinute) {
      minute = currentMinute;
      accepted = 0;
      visitors.clear();
    }
    const mine = visitors.get(client) ?? 0;
    if (accepted >= 30 || mine >= 5) return 429;
    accepted++;
    visitors.set(client, mine + 1);
    return 204;
  };
}

export function browserFingerprint(key: string, supplied: string): string {
  return createHmac("sha256", key).update(`runport-browser-fingerprint:${supplied}`).digest("hex");
}
