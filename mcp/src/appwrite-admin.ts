import { APP_KEY_SCOPES, config } from "./config";
import { readSecret } from "./keychain";
import { assertAppwriteId } from "./slug";

/** Validated and URL-encoded project id for use inside a route path. */
const seg = (projectId: string) => encodeURIComponent(assertAppwriteId(projectId));

// Talks to Appwrite's console API as the owner, the same way the admin screen
// does. Appwrite 1.x and 2.x expose project admin under different routes, so
// each operation lists its candidate routes in order; a route that does not
// exist (404/405) moves on to the next one. On 2.6.1 the first route of each
// operation answers (docs/spikes/create-project.md).

type Json = Record<string, unknown>;

type Route = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: Json;
  /** Overrides the console project header, for project-scoped routes. */
  project?: string;
};

export class AppwriteError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type?: string,
  ) {
    super(message);
  }
}

const isMissingRoute = (error: unknown) =>
  error instanceof AppwriteError && (error.status === 404 || error.status === 405) && error.type === "general_route_not_found";

export class AppwriteAdmin {
  private cookie: string | null = null;
  /** Route that answered the last successful `first()` call. Used by the spike. */
  lastRoute: string | null = null;

  constructor(private readonly endpoint = config.endpoint) {}

  private async login(): Promise<void> {
    const [email, password] = await Promise.all([readSecret("appwrite-owner-email"), readSecret("appwrite-owner-password")]);
    const res = await fetch(`${this.endpoint}/account/sessions/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Appwrite-Project": "console" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw await toError(res, "Owner login failed");
    const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]);
    if (cookies.length === 0) throw new Error("Owner login returned no session cookie.");
    this.cookie = cookies.join("; ");
  }

  private async send<T>(route: Route, retried = false): Promise<T> {
    if (!this.cookie) await this.login();
    const res = await fetch(`${this.endpoint}${route.path}`, {
      method: route.method,
      headers: {
        "Content-Type": "application/json",
        "X-Appwrite-Project": route.project ?? "console",
        // Appwrite 2.x rejects admin mode on the console project itself.
        ...(route.project ? { "X-Appwrite-Mode": "admin" } : {}),
        Cookie: this.cookie ?? "",
      },
      body: route.body ? JSON.stringify(route.body) : undefined,
    });
    if (res.status === 401 && !retried) {
      this.cookie = null;
      return this.send<T>(route, true);
    }
    if (!res.ok) throw await toError(res, `${route.method} ${route.path}`);
    return (res.status === 204 ? {} : await res.json()) as T;
  }

  /** Tries each route until one exists. Real errors (400, 403, 409) stop immediately. */
  private async first<T>(routes: Route[]): Promise<T> {
    let last: unknown;
    for (const route of routes) {
      try {
        const result = await this.send<T>(route);
        this.lastRoute = `${route.method} ${route.path}`;
        return result;
      } catch (error) {
        if (!isMissingRoute(error)) throw error;
        last = error;
      }
    }
    throw last ?? new Error("No route to try.");
  }

  async organizationId(): Promise<string> {
    const teams = await this.send<{ teams: { $id: string }[] }>({ method: "GET", path: "/teams" });
    const id = teams.teams[0]?.$id;
    if (!id) throw new Error("The owner account has no organization yet. Open the Appwrite admin once.");
    return id;
  }

  async getProject(projectId: string): Promise<{ $id: string; name: string } | null> {
    try {
      return await this.first([
        { method: "GET", path: `/projects/${seg(projectId)}` },
        { method: "GET", path: `/organization/projects/${seg(projectId)}` },
      ]);
    } catch (error) {
      if (error instanceof AppwriteError && error.status === 404) return null;
      throw error;
    }
  }

  async createProject(projectId: string, name: string): Promise<{ $id: string }> {
    const teamId = await this.organizationId();
    return this.first([
      { method: "POST", path: "/projects", body: { projectId: assertAppwriteId(projectId), name, teamId, region: "default" } },
      { method: "POST", path: "/organization/projects", body: { projectId, name } },
    ]);
  }

  async createServerKey(projectId: string, name: string): Promise<{ $id: string; secret: string }> {
    const body = { keyId: "unique()", name, scopes: APP_KEY_SCOPES, expire: null };
    return this.first([
      { method: "POST", path: `/projects/${seg(projectId)}/keys`, body },
      { method: "POST", path: `/organization/projects/${seg(projectId)}/keys`, body },
    ]);
  }

  /** Adds a web platform unless the project already allows that hostname. */
  async addWebPlatform(projectId: string, hostname: string): Promise<void> {
    const { platforms } = await this.first<{ platforms: { hostname?: string }[] }>([
      { method: "GET", path: `/projects/${seg(projectId)}/platforms` },
      { method: "GET", path: "/project/platforms", project: assertAppwriteId(projectId) },
    ]);
    if (platforms.some((p) => p.hostname === hostname)) return;
    // Platform ids are unique across all projects in 2.x, so let Appwrite pick one.
    const body = { platformId: "unique()", name: hostname, hostname };
    await this.first([
      { method: "POST", path: `/projects/${seg(projectId)}/platforms`, body: { ...body, type: "web" } },
      { method: "POST", path: "/project/platforms/web", project: assertAppwriteId(projectId), body },
    ]);
  }

  /** Sends the project's account mails (login codes, resets) through the mail gateway under the app's own name. */
  async setProjectSmtp(
    projectId: string,
    smtp: { senderName: string; senderEmail: string; host: string; port: number; username: string; password: string },
  ): Promise<void> {
    await this.send({
      method: "PATCH",
      path: "/project/smtp",
      project: assertAppwriteId(projectId),
      body: { enabled: true, ...smtp },
    });
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.first([
      { method: "DELETE", path: `/projects/${seg(projectId)}` },
      { method: "DELETE", path: `/organization/projects/${seg(projectId)}` },
    ]);
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.endpoint}/health/version`);
      return res.ok;
    } catch {
      return false;
    }
  }
}

async function toError(res: Response, context: string): Promise<AppwriteError> {
  let message = res.statusText;
  let type: string | undefined;
  try {
    const body = (await res.json()) as { message?: string; type?: string };
    message = body.message ?? message;
    type = body.type;
  } catch {
    // Non-JSON error page. Keep the status text.
  }
  return new AppwriteError(`${context}: ${message} (${res.status})`, res.status, type);
}
