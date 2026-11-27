import { createAppAlerts } from "./app-alerts";
import { loadConfig } from "./config";
import { cloudflareDelivery, sesDelivery, smtpDelivery } from "./deliver";
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

// Caddy publishes only the two authenticated app-alert paths.
Bun.serve({
  port: config.httpPort,
  fetch(req, server) {
    const { pathname } = new URL(req.url);
    if (pathname === "/health") return new Response("ok");
    if (pathname === "/stats") return Response.json(limits.today());
    if (pathname === "/internal/app-alerts") server.timeout(req, 60);
    return appAlerts(req);
  },
});
