import { EmailMessage } from "cloudflare:email";

// POST / with the raw MIME message as the body.
// Headers: Authorization: Bearer <SEND_TOKEN>, X-Mail-From, X-Mail-To (comma separated).
// The mail gateway has already checked caps and who may send as whom; this
// only re-checks the sender domain and delivers one copy per recipient.

interface Env {
  EMAIL: SendEmail;
  SEND_TOKEN: string;
  SENDER_DOMAIN: string;
}

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_RECIPIENTS = 50;

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  // Equal-length digests compared in full, so timing says nothing about the token.
  const [p, q] = [new Uint8Array(x), new Uint8Array(y)];
  let diff = 0;
  for (let i = 0; i < p.length; i++) diff |= p[i] ^ q[i];
  return diff === 0;
}

const ADDRESS = /^[^\s@<>,]+@[^\s@<>,]+$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") return json(405, { error: "POST only" });
    const auth = request.headers.get("authorization") ?? "";
    if (!env.SEND_TOKEN || !(await sameSecret(auth, `Bearer ${env.SEND_TOKEN}`))) return json(401, { error: "unauthorized" });

    const from = (request.headers.get("x-mail-from") ?? "").trim().toLowerCase();
    const to = (request.headers.get("x-mail-to") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!ADDRESS.test(from) || !from.endsWith(`@${env.SENDER_DOMAIN}`)) return json(400, { error: "sender not allowed" });
    if (to.length === 0 || to.length > MAX_RECIPIENTS || !to.every((t) => ADDRESS.test(t))) return json(400, { error: "bad recipients" });
    const length = Number(request.headers.get("content-length"));
    if (!Number.isFinite(length) || length <= 0 || length > MAX_BYTES) return json(413, { error: "bad size" });

    const raw = await request.text();
    const failed: { to: string; code: string; message: string }[] = [];
    for (const recipient of to) {
      try {
        await env.EMAIL.send(new EmailMessage(from, recipient, raw));
      } catch (error) {
        failed.push({ to: recipient, code: (error as { code?: string }).code ?? "E_UNKNOWN", message: (error as Error).message });
      }
    }
    if (failed.length === 0) return json(200, { sent: to.length });
    // Limits and outages are worth retrying; anything else is permanent.
    const retry = failed.some((f) => /RATE_LIMIT|DAILY_LIMIT|INTERNAL|DELIVERY_FAILED/.test(f.code));
    return json(retry ? 503 : 422, { sent: to.length - failed.length, failed });
  },
} satisfies ExportedHandler<Env>;
