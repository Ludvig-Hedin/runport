// The app's switches, all set through env vars. Read on every request, so a
// restart with new values is enough. No `server-only` import because the proxy
// uses this too; never import it from a client component.

export type AuthMode = "email-code" | "password";
export type OAuthProviderId = "google" | "github";

const isOn = (name: string) => process.env[name] === "1";

/** How people sign in. Email codes unless AUTH_MODE=password. */
export function authMode(): AuthMode {
  return process.env.AUTH_MODE === "password" ? "password" : "email-code";
}

/** Social sign-in buttons to show. The provider keys live in Appwrite. */
export function oauthProviders(): OAuthProviderId[] {
  const providers: OAuthProviderId[] = [];
  if (isOn("AUTH_GOOGLE")) providers.push("google");
  if (isOn("AUTH_GITHUB")) providers.push("github");
  return providers;
}

/** This app's public address without a trailing slash. Appwrite links back here. */
export function appUrl(): string {
  const url = process.env.APP_URL?.trim() || `http://localhost:${process.env.PORT || 3000}`;
  return url.replace(/\/+$/, "");
}

/** The password that locks the whole site, or null when the site is open. */
export function sitePassword(): string | null {
  return process.env.SITE_PASSWORD || null;
}

/** Only an open production deploy that opted in may be indexed. Previews never are. */
export function indexingAllowed(): boolean {
  const environment = process.env.RAILWAY_ENVIRONMENT_NAME;
  const production = !environment || environment === "production";
  return isOn("ALLOW_INDEXING") && production && !sitePassword();
}
