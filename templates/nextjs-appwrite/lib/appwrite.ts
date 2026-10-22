import "server-only";
import { cookies } from "next/headers";
import { Account, Client, TablesDB } from "node-appwrite";

// Every Appwrite call runs on the server. The browser only ever sees this
// app's own cookie, so login keeps working when Appwrite lives on another host.

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in .env.local`);
  return value;
}

export const config = {
  endpoint: () => env("APPWRITE_ENDPOINT"),
  projectId: () => env("APPWRITE_PROJECT_ID"),
  apiKey: () => env("APPWRITE_API_KEY"),
};

// Cookies on localhost are shared across ports, so the name carries the
// project id to keep two local apps from overwriting each other's session.
export function sessionCookieName(): string {
  return `session_${config.projectId()}`;
}

function baseClient(): Client {
  return new Client().setEndpoint(config.endpoint()).setProject(config.projectId());
}

/** Acts with full project rights. Never pass its results to the browser unfiltered. */
export function createAdminClient() {
  const client = baseClient().setKey(config.apiKey());
  return {
    account: new Account(client),
    tables: new TablesDB(client),
  };
}

/** Acts as the signed-in user, so row permissions apply. Throws when signed out. */
export async function createSessionClient() {
  const session = (await cookies()).get(sessionCookieName());
  if (!session?.value) throw new Error("No session");
  const client = baseClient().setSession(session.value);
  return {
    account: new Account(client),
    tables: new TablesDB(client),
  };
}
