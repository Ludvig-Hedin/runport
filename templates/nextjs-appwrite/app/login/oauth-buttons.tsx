"use client";

import { useFormStatus } from "react-dom";
import type { OAuthProviderId } from "@/lib/config";
import { startOAuth } from "@/lib/oauth";
import { secondaryButton } from "../auth-ui";

const LABELS: Record<OAuthProviderId, string> = {
  google: "Continue with Google",
  github: "Continue with GitHub",
};

function ProviderButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button disabled={pending} className={`w-full ${secondaryButton}`}>
      {pending ? "Working…" : label}
    </button>
  );
}

export function OAuthButtons({ providers }: { providers: OAuthProviderId[] }) {
  if (providers.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {providers.map((provider) => (
        <form key={provider} action={startOAuth.bind(null, provider)}>
          <ProviderButton label={LABELS[provider]} />
        </form>
      ))}
    </div>
  );
}
