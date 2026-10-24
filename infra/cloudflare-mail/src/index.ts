import { EmailMessage } from "cloudflare:email";

// POST / with the raw MIME message as the body.
// Headers: Authorization: Bearer <SEND_TOKEN>, X-Mail-From, X-Mail-To (a JSON
// array of addresses). Answers 200 with how many recipients got it and the
// error codes for the rest, so the caller can tell partial from full failure.
// The mail gateway has already checked caps and who may send as whom; this
// only re-checks the sender domain and delivers one copy per recipient.

interface Env {
  EMAIL: SendEmail;
  SEND_TOKEN: string;
  /** Comma-separated domains apps may send from. */
  SENDER_DOMAINS: string;
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
    let to: unknown;
    try {
      to = JSON.parse(request.headers.get("x-mail-to") ?? "");
    } catch {
      return json(400, { error: "bad recipients" });
    }
    const domains = env.SENDER_DOMAINS.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
    if (!ADDRESS.test(from) || !domains.includes(from.slice(from.lastIndexOf("@") + 1))) return json(400, { error: "sender not allowed" });
    if (!Array.isArray(to) || to.length === 0 || to.length > MAX_RECIPIENTS || !to.every((t) => typeof t === "string" && ADDRESS.test(t))) {
      return json(400, { error: "bad recipients" });
    }
    const length = Number(request.headers.get("content-length"));
    if (!Number.isFinite(length) || length <= 0 || length > MAX_BYTES) return json(413, { error: "bad size" });

    const raw = await request.text();
    // Codes only, never addresses, so nothing personal ends up in logs.
    const codes: string[] = [];
    let sent = 0;
    for (const recipient of to as string[]) {
      try {
        await env.EMAIL.send(new EmailMessage(from, recipient, raw));
        sent++;
      } catch (error) {
        codes.push((error as { code?: string }).code ?? "E_UNKNOWN");
      }
    }
    return json(200, { sent, failed: codes.length, codes });
  },
} satisfies ExportedHandler<Env>;
