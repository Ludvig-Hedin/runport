import { homedir } from "node:os";
import { join } from "node:path";

export async function railwayApi<T>(query: string, variables: object): Promise<T> {
  let token = process.env.RAILWAY_API_TOKEN;
  if (!token) {
    const login = JSON.parse(await Bun.file(join(homedir(), ".railway", "config.json")).text()) as {
      user?: { accessToken?: string; token?: string };
    };
    token = login.user?.accessToken ?? login.user?.token;
  }
  if (!token) throw new Error("Could not find the Railway CLI login.");
  const response = await fetch("https://backboard.railway.com/graphql/v2", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }), redirect: "error", signal: AbortSignal.timeout(10_000),
  }).catch(() => { throw new Error("Could not reach the Railway API."); });
  const body = await response.json().catch(() => null) as { data?: T; errors?: unknown[] } | null;
  // Railway errors may echo inputs containing write-only webhook headers.
  if (!response.ok || !body?.data || body.errors?.length) throw new Error(`Railway API refused the request (${response.status}).`);
  return body.data;
}
