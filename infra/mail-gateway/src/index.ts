import { createAppAlerts } from "./app-alerts";
import { loadConfig } from "./config";
import { cloudflareDelivery, sesDelivery, smtpDelivery } from "./deliver";
import { formMailHandler } from "./form-mail";
import { Limits } from "./limits";
import { createSmtpServer, jsonLog } from "./server";

const config = loadConfig();
const limits = new Limits(config.dataFile, config.caps);
function pickDelivery() {
  if (config.delivery === "cloudflare") {
    if (!config.cloudflareUrl || !config.cloudflareToken) throw new Error("DELIVERY=cloudflare needs CLOUDFLARE_MAIL_URL and CLOUDFLARE_MAIL_TOKEN.");
    return cloudflareDelivery(config.cloudflareUrl, config.cloudflareToken);
  }
  return config.delivery === "ses" ? sesDelivery(config.sesRegion) : smtpDelivery(config.forwardHost, config.forwardPort);
}
const deliver = pickDelivery();
const appAlerts = createAppAlerts({
  path: config.dataFile === ":memory:" ? ":memory:" : `${config.dataFile}.app-alerts`,
  master: config.masterKey,
  owner: process.env.ALERT_TO,
  limits,
  deliver,
  log: jsonLog,
});

const smtp = createSmtpServer(config, limits, deliver);
smtp.on("error", (error) => jsonLog({ result: "smtp-error", reason: error.message }));
smtp.listen(config.smtpPort, () => jsonLog({ result: "listening", smtpPort: config.smtpPort, delivery: config.delivery, caps: config.caps }));

// The router forwards only the authenticated form, registration and report endpoints.
const sendFormMail = formMailHandler(config, limits, deliver);
Bun.serve({
  port: config.httpPort,
  maxRequestBodySize: 32 * 1024,
  fetch(req, server) {
    const { pathname } = new URL(req.url);
    if (pathname === "/runport-mail/form") return sendFormMail(req);
    if (pathname === "/health") return new Response("ok");
    if (pathname === "/stats") return Response.json(limits.today());
    if (pathname === "/internal/app-alerts") server.timeout(req, 60);
    if (pathname.startsWith("/_runport/alerts/railway/")) server.timeout(req, 25);
    return appAlerts(req);
  },
});
