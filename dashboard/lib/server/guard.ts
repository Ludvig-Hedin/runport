import "server-only";
import { ownerOrResponse } from "@/lib/owner";
import { findApp, type RunportApp } from "./railway";

/** Checks the owner, the same-origin request and that the slug is a Runport app. */
export async function guardAction(request: Request, slug: string): Promise<{ app: RunportApp } | { response: Response }> {
  const owner = await ownerOrResponse();
  if ("response" in owner) return owner;
  // Actions are only posted from the dashboard itself.
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (request.method !== "GET" && (!origin || !host || new URL(origin).host !== host)) {
    return { response: Response.json({ error: "Wrong origin" }, { status: 403 }) };
  }
  const app = await findApp(slug);
  if (!app) return { response: Response.json({ error: "That is not a Runport app." }, { status: 404 }) };
  return { app };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}
