import type { CSSProperties } from "react";
import { appearance as globalAppearance } from "@/runport.config";

// The styling contract for the auth components, modelled on Clerk's
// `appearance` prop: theme variables, a few layout switches and extra
// classes per element. Safe to import from server and client components.

/** A CSS colour or length, or one value per theme. */
export type Themed = string | { light: string; dark: string };

export type AppearanceVariables = {
  colorPrimary?: Themed;
  colorPrimaryText?: Themed;
  colorBackground?: Themed;
  colorText?: Themed;
  colorTextMuted?: Themed;
  colorInputBackground?: Themed;
  colorBorder?: Themed;
  colorDanger?: Themed;
  colorSuccess?: Themed;
  /** Radius of fields. The card and code boxes scale from it. */
  borderRadius?: string;
  /** Radius of buttons. Pills by default; set it equal to borderRadius for square-ish buttons. */
  buttonRadius?: string;
  fontFamily?: string;
};

export type AppearanceLayout = {
  /** An image shown above the title. Without it, the app's initial is shown. */
  logoUrl?: string;
  /** Social buttons above or below the email field. */
  socialButtonsPlacement?: "top" | "bottom";
  /** Draw the card with a border and shadow, or flat on the page. */
  card?: "raised" | "flat";
};

export const ELEMENTS = [
  "root",
  "card",
  "logo",
  "header",
  "title",
  "subtitle",
  "form",
  "label",
  "input",
  "codeInput",
  "primaryButton",
  "secondaryButton",
  "socialButton",
  "divider",
  "link",
  "alert",
  "notice",
  "footer",
  "userButton",
  "userButtonAvatar",
  "userButtonMenu",
  "userButtonMenuItem",
] as const;

export type ElementName = (typeof ELEMENTS)[number];

export type Appearance = {
  variables?: AppearanceVariables;
  layout?: AppearanceLayout;
  /** Extra class names per element. Tailwind classes here win over the defaults. */
  elements?: Partial<Record<ElementName, string>>;
};

export type ResolvedAppearance = {
  style: CSSProperties;
  layout: Required<Omit<AppearanceLayout, "logoUrl">> & Pick<AppearanceLayout, "logoUrl">;
  /** The class list for one element: the built-in class plus any extras. */
  cls: (element: ElementName, extra?: string) => string;
};

const VARIABLE_TO_CSS: Record<keyof AppearanceVariables, string> = {
  colorPrimary: "--rp-primary",
  colorPrimaryText: "--rp-primary-text",
  colorBackground: "--rp-bg",
  colorText: "--rp-text",
  colorTextMuted: "--rp-muted",
  colorInputBackground: "--rp-input-bg",
  colorBorder: "--rp-border",
  colorDanger: "--rp-danger",
  colorSuccess: "--rp-success",
  borderRadius: "--rp-radius",
  buttonRadius: "--rp-button-radius",
  fontFamily: "--rp-font",
};

const toCss = (value: Themed) => (typeof value === "string" ? value : `light-dark(${value.light}, ${value.dark})`);

/** Merges the app-wide appearance from runport.config.ts with a per-screen one. */
export function resolveAppearance(local?: Appearance): ResolvedAppearance {
  const variables = { ...globalAppearance.variables, ...local?.variables };
  const layout = { ...globalAppearance.layout, ...local?.layout };
  const elements = { ...globalAppearance.elements, ...local?.elements };

  const style: Record<string, string> = {};
  for (const [key, value] of Object.entries(variables) as [keyof AppearanceVariables, Themed | undefined][]) {
    if (value !== undefined) style[VARIABLE_TO_CSS[key]] = toCss(value);
  }

  return {
    style: style as CSSProperties,
    layout: {
      logoUrl: layout.logoUrl,
      socialButtonsPlacement: layout.socialButtonsPlacement ?? "top",
      card: layout.card ?? "raised",
    },
    cls: (element, extra) => [`rp-${element}`, extra, elements[element]].filter(Boolean).join(" "),
  };
}
