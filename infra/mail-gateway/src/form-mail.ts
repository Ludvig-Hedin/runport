import { createHmac, timingSafeEqual } from "node:crypto";
import nodemailer from "nodemailer";
import type { Config } from "./config";
import { APP_ID, SYSTEM_SENDER, appPassword, senderProblem } from "./identity";

const address = /^[a-z\d.!#$%&'*+/=?^_`{|}~-]+@[a-z\d-]+(?:\.[a-z\d-]+)+$/i;

export function formMailHandler(config: Config) {
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

    const smtp = nodemailer.createTransport({
      host: "127.0.0.1",
      port: config.smtpPort,
      secure: false,
      ignoreTLS: true,
      auth: { user: app, pass: appPassword(config.masterKey, app) },
      connectionTimeout: 2000,
      greetingTimeout: 2000,
      socketTimeout: 7000,
    });
    try {
      await smtp.sendMail({
        envelope: { from: body.from, to: [body.to] },
        from: body.from,
        to: body.to,
        subject: body.subject,
        text: body.text,
      });
      return new Response(null, { status: 204 });
    } catch (error) {
      const code = (error as { responseCode?: number }).responseCode;
      return new Response(null, { status: code === 550 ? 429 : 502 });
    }
  };
}
