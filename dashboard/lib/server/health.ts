import "server-only";
import { platformService } from "./railway";

// Platform health as the owner sees it. Public health URLs where they exist;
// the mail gateway is private to Runport's network, so its Railway status is used.

export type Health = { name: string; state: "ok" | "down" | "unknown"; detail?: string };

async function probe(url: string): Promise<Health["state"]> {
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(6_000) });
    return res.ok ? "ok" : "down";
  } catch {
    return "down";
  }
}

export async function platformHealth(): Promise<Health[]> {
  const appwrite = (process.env.APPWRITE_ENDPOINT ?? "").replace(/\/+$/, "");
  const [aw, git, analytics, mail] = await Promise.all([
    probe(`${appwrite}/health/version`),
    probe("https://git.runport.app/api/healthz"),
    probe("https://analytics.runport.app/api/heartbeat"),
    platformService("mail-gateway").then(
      (s): Health["state"] => {
        const d = s?.latestDeployment;
        if (!d) return "unknown";
        return d.status === "SUCCESS" && !d.deploymentStopped ? "ok" : "down";
      },
      (): Health["state"] => "unknown",
    ),
  ]);
  return [
    { name: "Appwrite", state: aw, detail: "Sign-in, data and files" },
    { name: "Mail", state: mail, detail: "Login codes and app email" },
    { name: "Git", state: git, detail: "git.runport.app" },
    { name: "Analytics", state: analytics, detail: "Visitor stats" },
  ];
}
