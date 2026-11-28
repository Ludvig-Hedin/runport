import "server-only";
import { SafeError, safeMessage } from "@/lib/ops/errors";
import { ownerOrResponse } from "@/lib/owner";
import { findApp, type RunportApp } from "./railway";

/** The dashboard's own origin, from APP_URL. Writes are only accepted from it. */
function ownOrigin(): string | null {
  try {
    return new URL(process.env.APP_URL ?? "").origin;
  } catch {
    return null;
  }
}

/** Checks the owner, the exact request origin and that the slug is a verified, pinned app. */
export async function guardAction(request: Request, slug: string): Promise<{ app: RunportApp } | { response: Response }> {
  const owner = await ownerOrResponse();
  if ("response" in owner) return owner;
  if (request.method !== "GET") {
    const origin = request.headers.get("origin");
    const own = ownOrigin();
    if (!origin || !own || origin !== own) return { response: Response.json({ error: "Wrong origin" }, { status: 403 }) };
  }
  const app = await findApp(slug);
  if (!app) return { response: Response.json({ error: "That is not a verified Runport app." }, { status: 404 }) };
  return { app };
}

/** Only messages we wrote ourselves (SafeError) reach the browser; anything else gets a fixed one. */
export function errorMessage(error: unknown): string {
  if (!(error instanceof SafeError)) console.error("[dashboard] action failed:", error instanceof Error ? error.name : typeof error);
  return safeMessage(error);
}
