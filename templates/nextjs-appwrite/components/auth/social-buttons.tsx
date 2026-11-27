"use client";

import { useFormStatus } from "react-dom";
import type { OAuthProviderId } from "@/lib/config";
import { startOAuth } from "@/lib/oauth";
import { type Appearance, resolveAppearance } from "./appearance";
import { Spinner } from "./controls";

const PROVIDERS: Record<OAuthProviderId, { label: string; icon: React.ReactNode }> = {
  google: {
    label: "Continue with Google",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.2-2.1 3.5-5.1 3.5-8.7Z" />
        <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24Z" />
        <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6h-4a12 12 0 0 0 0 10.8l4-3.1Z" />
        <path fill="#EA4335" d="M12 4.8c1.8 0 3.4.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.8 3.6-4.9 6.7-4.9Z" />
      </svg>
    ),
  },
  github: {
    label: "Continue with GitHub",
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
        <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 0-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.2.5-2.3 1.3-3.1-.2-.4-.6-1.6 0-3.2 0 0 1-.3 3.4 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.6.2 2.8.1 3.2.8.8 1.2 1.9 1.2 3.1 0 4.6-2.8 5.6-5.5 5.9.5.4.9 1.1.9 2.3v3.3c0 .3.1.7.8.6A12 12 0 0 0 12 .3" />
      </svg>
    ),
  },
};

function ProviderButton({ provider, appearance }: { provider: OAuthProviderId; appearance?: Appearance }) {
  const { pending } = useFormStatus();
  const { label, icon } = PROVIDERS[provider];
  return (
    <button disabled={pending} aria-busy={pending || undefined} className={resolveAppearance(appearance).cls("socialButton")}>
      {pending ? <Spinner /> : icon}
      <span>{label}</span>
    </button>
  );
}

/** Google and GitHub buttons. Renders nothing when no provider is switched on. */
export function SocialButtons({ providers, appearance }: { providers: OAuthProviderId[]; appearance?: Appearance }) {
  if (providers.length === 0) return null;
  return (
    <div className="rp-social">
      {providers.map((provider) => (
        <form key={provider} action={startOAuth.bind(null, provider)}>
          <ProviderButton provider={provider} appearance={appearance} />
        </form>
      ))}
    </div>
  );
}
