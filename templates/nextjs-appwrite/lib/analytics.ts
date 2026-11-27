"use client";

type EventProps = Record<string, string | number | boolean>;

export function track(event: string, props?: EventProps): void {
  if (typeof window === "undefined") return;
  const browser = window as Window & {
    umami?: { track: (name: string, data?: EventProps) => void };
  };
  browser.umami?.track(event, props);
}
