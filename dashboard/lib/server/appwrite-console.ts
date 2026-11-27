import "server-only";

// Appwrite's console API, signed in as the platform owner. Self-hosted
// Appwrite has no key that can delete projects, so this login is needed for
// delete and for reading app names. It never leaves the server.

const endpoint = () => (process.env.APPWRITE_ENDPOINT ?? "").replace(/\/+$/, "");

async function login(): Promise<string> {
  const email = process.env.APPWRITE_CONSOLE_EMAIL;
  const password = process.env.APPWRITE_CONSOLE_PASSWORD;
  if (!email || !password) throw new Error("The Appwrite console login is not configured.");
  const res = await fetch(`${endpoint()}/account/sessions/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Appwrite-Project": "console" },
    body: JSON.stringify({ email, password }),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Appwrite console sign-in failed (HTTP ${res.status}).`);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("Appwrite console sign-in returned no session.");
  return cookie;
}

async function send(method: string, path: string, cookie: string): Promise<Response> {
  return fetch(`${endpoint()}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Appwrite-Project": "console", Cookie: cookie },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
}

/** Ends the console session again, so no extra sessions pile up on the owner account. */
async function logout(cookie: string): Promise<void> {
  await send("DELETE", "/account/sessions/current", cookie).catch(() => {});
}

/** App display names by project id. */
export async function projectNames(): Promise<Map<string, string>> {
  const cookie = await login();
  try {
    const q = encodeURIComponent(JSON.stringify({ method: "limit", values: [500] }));
    const res = await send("GET", `/projects?queries[]=${q}`, cookie);
    if (!res.ok) throw new Error(`Appwrite: HTTP ${res.status}`);
    const body = (await res.json()) as { projects: { $id: string; name: string }[] };
    return new Map(body.projects.map((p) => [p.$id, p.name]));
  } finally {
    await logout(cookie);
  }
}

/** Deletes the app's Appwrite project: its users, data and files. */
export async function deleteAppwriteProject(projectId: string): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{0,35}$/.test(projectId) || projectId === process.env.APPWRITE_PROJECT_ID) {
    throw new Error("Refusing to delete this Appwrite project.");
  }
  const cookie = await login();
  try {
    const res = await send("DELETE", `/projects/${encodeURIComponent(projectId)}`, cookie);
    if (!res.ok && res.status !== 404) throw new Error(`Appwrite refused to delete the project (HTTP ${res.status}).`);
  } finally {
    await logout(cookie);
  }
}
