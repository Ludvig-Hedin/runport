"use server";

import { redirect } from "next/navigation";
import { OAuthProvider } from "node-appwrite";
import { createAdminClient } from "./appwrite";
import { appUrl, oauthProviders, type OAuthProviderId } from "./config";
import { newOAuthState } from "./oauth-state";

// Google and GitHub sign-in. Appwrite sends the person back to /auth/oauth
// with a one-time token, which app/auth/oauth/[state]/route.ts turns into a session.

const PROVIDERS: Record<OAuthProviderId, OAuthProvider> = {
  google: OAuthProvider.Google,
  github: OAuthProvider.Github,
};

export async function startOAuth(provider: OAuthProviderId): Promise<void> {
  const failure = `${appUrl()}/login?error=oauth`;
  let target = "/login?error=oauth";
  if (oauthProviders().includes(provider)) {
    try {
      const { account } = createAdminClient();
      target = await account.createOAuth2Token({
        provider: PROVIDERS[provider],
        success: `${appUrl()}/auth/oauth/${await newOAuthState()}`,
        failure,
      });
    } catch (error) {
      console.error(error);
    }
  }
  redirect(target);
}
