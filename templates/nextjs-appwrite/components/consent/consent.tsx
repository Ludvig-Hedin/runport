"use client";

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import { type Appearance, resolveAppearance } from "@/components/auth/appearance";
import { consent as consentConfig } from "@/runport.config";

// Cookie consent, built in. It only appears when runport.config.ts lists
// cookie categories that need consent. Cookies the app needs to work (the
// sign-in session, the site lock) never need consent, and Runport's own
// analytics sets no cookies, so a fresh app shows no banner at all.

export type ConsentCategory = "analytics" | "marketing" | "preferences";
export type ConsentChoice = Record<ConsentCategory, boolean>;

const COOKIE = "rp_consent";
const MAX_AGE = 60 * 60 * 24 * 180; // ask again after six months
const NONE: ConsentChoice = { analytics: false, marketing: false, preferences: false };

const CATEGORY_TEXT: Record<ConsentCategory, { title: string; body: string }> = {
  analytics: { title: "Statistics", body: "Helps us see how the site is used, so we can improve it." },
  marketing: { title: "Marketing", body: "Lets ads and social media show you relevant content." },
  preferences: { title: "Preferences", body: "Remembers choices like language or region." },
};

function readChoice(): ConsentChoice | null {
  const raw = document.cookie.split("; ").find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw.slice(COOKIE.length + 1)));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (record.v !== consentConfig.version) return null; // the categories changed: ask again
    // Only a literal true counts as consent; anything else is a no.
    return { analytics: record.analytics === true, marketing: record.marketing === true, preferences: record.preferences === true };
  } catch {
    return null;
  }
}

function saveChoice(choice: ConsentChoice): void {
  const value = encodeURIComponent(JSON.stringify({ ...choice, v: consentConfig.version }));
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${COOKIE}=${value}; Path=/; Max-Age=${MAX_AGE}; SameSite=Lax${secure}`;
}

type ConsentContextValue = {
  /** null until the visitor has chosen. */
  choice: ConsentChoice | null;
  openSettings: () => void;
};

const ConsentContext = createContext<ConsentContextValue>({ choice: null, openSettings: () => {} });

/** True once the visitor allowed this category. Use it before loading a script that sets cookies. */
export function useConsent(category: ConsentCategory): boolean {
  const { choice } = useContext(ConsentContext);
  if (!consentConfig.categories.includes(category)) return false;
  return choice?.[category] === true;
}

/** Renders its children only after the visitor allowed `category`. */
export function ConsentGate({ category, children }: { category: ConsentCategory; children: React.ReactNode }) {
  return useConsent(category) ? <>{children}</> : null;
}

/** A link for the footer that opens the cookie settings again. Hidden when the app needs no consent. */
export function CookieSettingsLink({ className, children = "Cookie settings" }: { className?: string; children?: React.ReactNode }) {
  const { openSettings } = useContext(ConsentContext);
  if (consentConfig.categories.length === 0) return null;
  return (
    <button type="button" onClick={openSettings} className={className ?? "rp-link"}>
      {children}
    </button>
  );
}

/** Wrap the app with this once, in app/layout.tsx. */
export function ConsentProvider({ appearance, children }: { appearance?: Appearance; children: React.ReactNode }) {
  const [choice, setChoice] = useState<ConsentChoice | null>(null);
  const [view, setView] = useState<"hidden" | "banner" | "settings">("hidden");
  const needed = consentConfig.categories.length > 0;

  useEffect(() => {
    if (!needed) return;
    const saved = readChoice();
    setChoice(saved);
    if (!saved) setView("banner");
  }, [needed]);

  const decide = useCallback((next: ConsentChoice) => {
    saveChoice(next);
    setChoice(next);
    setView("hidden");
  }, []);

  const openSettings = useCallback(() => setView("settings"), []);

  return (
    <ConsentContext.Provider value={{ choice, openSettings }}>
      {children}
      {needed && view !== "hidden" && (
        <ConsentPanel appearance={appearance} view={view} choice={choice} onDecide={decide} onCustomize={openSettings} />
      )}
    </ConsentContext.Provider>
  );
}

type PanelProps = {
  appearance?: Appearance;
  view: "banner" | "settings";
  choice: ConsentChoice | null;
  onDecide: (choice: ConsentChoice) => void;
  onCustomize: () => void;
};

function ConsentPanel({ appearance, view, choice, onDecide, onCustomize }: PanelProps) {
  const { style, cls } = resolveAppearance(appearance);
  const titleId = useId();
  const categories = consentConfig.categories;
  const [draft, setDraft] = useState<ConsentChoice>(choice ?? NONE);
  const all = Object.fromEntries(categories.map((c) => [c, true])) as Partial<ConsentChoice>;
  const card = useRef<HTMLDivElement>(null);

  // Tell the page how tall the panel is, so pages can keep their content scrollable above it.
  useEffect(() => {
    const root = document.documentElement;
    const node = card.current;
    if (!node) return;
    const observer = new ResizeObserver(() => root.style.setProperty("--rp-consent-h", `${node.offsetHeight + 24}px`));
    observer.observe(node);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--rp-consent-h");
    };
  }, []);

  return (
    <section className={cls("root", "rp-consent")} style={style} role="dialog" aria-modal="false" aria-labelledby={titleId}>
      <div ref={card} className={cls("card", "rp-consent-card")} data-variant="raised">
        <h2 id={titleId} className="rp-consent-title">
          {view === "banner" ? "We use cookies" : "Cookie settings"}
        </h2>
        <p className="rp-consent-text">
          Some cookies keep the site working and are always on. With your OK we also use cookies for{" "}
          {categories.map((c) => CATEGORY_TEXT[c].title.toLowerCase()).join(" and ")}. You can change this at any time.
          {consentConfig.policyUrl && (
            <>
              {" "}
              <a href={consentConfig.policyUrl} className={cls("link")}>Read more</a>
            </>
          )}
        </p>

        {view === "settings" && (
          <ul className="rp-consent-list">
            <li className="rp-consent-item">
              <div>
                <p className="rp-consent-item-title">Necessary</p>
                <p className="rp-consent-item-body">Sign-in and security. The site does not work without these.</p>
              </div>
              <span className="rp-consent-always">Always on</span>
            </li>
            {categories.map((category) => (
              <li key={category} className="rp-consent-item">
                <label htmlFor={`rp-consent-${category}`}>
                  <p className="rp-consent-item-title">{CATEGORY_TEXT[category].title}</p>
                  <p className="rp-consent-item-body">{CATEGORY_TEXT[category].body}</p>
                </label>
                <input
                  id={`rp-consent-${category}`}
                  type="checkbox"
                  role="switch"
                  className="rp-switch"
                  checked={draft[category]}
                  onChange={(e) => setDraft((d) => ({ ...d, [category]: e.target.checked }))}
                />
              </li>
            ))}
          </ul>
        )}

        {/* Accept and reject carry the same weight, as EU guidance asks. */}
        <div className="rp-consent-actions">
          <button type="button" className={cls("secondaryButton")} onClick={() => onDecide(NONE)}>
            Only necessary
          </button>
          <button type="button" className={cls("secondaryButton")} onClick={() => onDecide({ ...NONE, ...all })}>
            Accept all
          </button>
          {view === "banner" ? (
            <button type="button" className={cls("link", "rp-consent-more")} onClick={onCustomize}>
              Choose
            </button>
          ) : (
            <button type="button" className={cls("primaryButton", "rp-consent-save")} onClick={() => onDecide(draft)}>
              Save choices
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
