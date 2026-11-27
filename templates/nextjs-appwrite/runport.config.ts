import type { Appearance } from "@/components/auth/appearance";

// The look and routes of the ready-made sign-in components in components/auth.
// Change this file to restyle every auth screen at once. A single screen can
// also take its own `appearance` prop, which is merged on top of this one.

export const appName = "New app";

export const routes = {
  /** Where people land after signing in or creating an account. */
  afterSignIn: "/items",
  /** Where people land after signing out. */
  afterSignOut: "/login",
};

/**
 * Cookie consent. Leave `categories` empty while the app only uses cookies it
 * needs to work (sign-in, site lock) and Runport's cookie-free analytics: then
 * no banner shows. Add a category when you add something that sets such
 * cookies (an ad pixel, a chat widget), and load it inside
 * <ConsentGate category="…"> from components/consent.
 */
export const consent: {
  categories: ("analytics" | "marketing" | "preferences")[];
  /** Raise by one when categories change, so everyone is asked again. */
  version: number;
  policyUrl?: string;
} = {
  categories: [],
  version: 1,
};

export const appearance: Appearance = {
  variables: {
    // Any CSS colour. Use { light, dark } to set each theme separately.
    colorPrimary: { light: "#111111", dark: "#f5f5f5" },
    colorPrimaryText: { light: "#ffffff", dark: "#111111" },
    // borderRadius: "18px",
    // fontFamily: "Inter, system-ui, sans-serif",
  },
  layout: {
    // logoUrl: "/logo.svg",
    socialButtonsPlacement: "top",
  },
  // Extra Tailwind classes per part, for example { card: "shadow-xl", primaryButton: "uppercase" }.
  // They win over the built-in styles without needing "!".
  elements: {},
};
