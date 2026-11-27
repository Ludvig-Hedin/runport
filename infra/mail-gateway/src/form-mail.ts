import { createHmac, timingSafeEqual } from "node:crypto";
import nodemailer from "nodemailer";
import { deliverWithinBudget, jsonLog, MailBudgetExceeded, type MailLog } from "./budgeted-delivery";
import type { Config } from "./config";
import type { Deliver } from "./deliver";
import { APP_ID, SYSTEM_SENDER, senderProblem } from "./identity";
import type { Limits } from "./limits";

const address = /^[a-z\d.!#$%&'*+/=?^_`{|}~-]+@[a-z\d-]+(?:\.[a-z\d-]+)+$/i;

export function formMailHandler(config: Config, limits: Pick<Limits, "reserve" | "release">, deliver: Deliver, log: MailLog = jsonLog) {
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const app = request.headers.get("x-runport-app") ?? "";
    const token = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!token || !APP_ID.test(app) || app === SYSTEM_SENDER) return new Response(null, { status: 401 });

    const body = await request.json().catch(() => null);
    if (!body || typeof body.to !== "string" || body.to.length > 254 || !address.test(body.to)) {
      return new Response(null, { status: 400 });
    }
    // A recipient-bound form token cannot authenticate over SMTP or send to other addresses.
    const expected = createHmac("sha256", config.masterKey).update(`form-mail:${app}:${body.to.toLowerCase()}`).digest();
    if (!timingSafeEqual(expected, Buffer.from(token, "hex"))) return new Response(null, { status: 401 });
    if (typeof body.from !== "string" || body.from.length > 254 || !address.test(body.from) ||
        senderProblem(app, body.from, config.senderDomains) ||
        typeof body.subject !== "string" || !body.subject || body.subject.length > 250 || /[\r\n]/.test(body.subject) ||
        typeof body.text !== "string" || !body.text || Buffer.byteLength(body.text) > 16000) {
      return new Response(null, { status: 400 });
    }

    try {
      const { message } = await composer.sendMail({
        from: body.from,
        to: body.to,
        subject: body.subject,
        text: body.text,
      });
      if (!Buffer.isBuffer(message)) return new Response(null, { status: 502 });
      if (message.length > config.maxBytes) return new Response(null, { status: 413 });
      const delivered = await deliverWithinBudget(limits, deliver, log, app, "form", { from: body.from, to: [body.to] }, message);
      return new Response(null, { status: delivered === 1 ? 204 : 502 });
    } catch (error) {
      return new Response(null, { status: error instanceof MailBudgetExceeded ? 429 : 502 });
    }
  };
}
