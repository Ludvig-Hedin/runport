import { expect, test } from "bun:test";
import { browserGrant, createBrowserAdmission } from "../templates/nextjs-appwrite/lib/browser-admission";

const key = "isolated-smoke-secret";
const now = 123_456_000;
const origin = "https://app.example.test";
const ip = "192.0.2.1";
const request = (grant: string, options: { ip?: string; origin?: string } = {}) =>
  new Request(origin + "/api/runport/error", { headers: {
    Origin: options.origin ?? origin,
    Host: "app.example.test", "X-Forwarded-Proto": "https",
    "X-Real-IP": options.ip ?? ip, "X-Runport-Error-Grant": grant,
  } });

test("browser admission requires a current grant bound to the trusted edge IP and same origin", () => {
  const admit = createBrowserAdmission();
  const grant = browserGrant(key, ip, now);
  expect(grant).not.toContain(ip);
  expect(admit(request(""), key, true, now)).toBe(403);
  expect(admit(request(grant, { ip: "192.0.2.2" }), key, true, now)).toBe(403);
  expect(admit(request(grant, { origin: "https://other.example.test" }), key, true, now)).toBe(403);
  expect(admit(request(grant), key, true, now + 21 * 60_000)).toBe(403);
  expect(admit(request(grant), key, true, now)).toBe(204);
});

test("browser forwarding has bounded per-IP and global budgets", () => {
  const admit = createBrowserAdmission();
  const grant = browserGrant(key, ip, now);
  for (let i = 0; i < 5; i++) expect(admit(request(grant), key, true, now)).toBe(204);
  expect(admit(request(grant), key, true, now)).toBe(429);
  for (let i = 2; i <= 26; i++) {
    const otherIp = `192.0.2.${i}`;
    expect(admit(request(browserGrant(key, otherIp, now), { ip: otherIp }), key, true, now)).toBe(204);
  }
  expect(admit(request(browserGrant(key, "192.0.2.27", now), { ip: "192.0.2.27" }), key, true, now)).toBe(429);
});
