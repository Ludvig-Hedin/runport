"use client";

import Script from "next/script";
import { useEffect, useRef, useState } from "react";

type Widget = {
  render: (target: HTMLElement, options: Record<string, unknown>) => string;
  reset: (id: string) => void;
  remove: (id: string) => void;
};

export function Turnstile({ siteKey, resetOn, onToken }: { siteKey: string; resetOn: unknown; onToken: (token: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<{ api: Widget; id: string }>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const api = (window as Window & { turnstile?: Widget }).turnstile;
    if (!ready || !api || !container.current) return;
    const fail = () => { onToken(""); setFailed(true); };
    const id = api.render(container.current, {
      sitekey: siteKey,
      action: "runport-form",
      theme: "auto",
      size: "flexible",
      "response-field": false,
      callback: (token: string) => { onToken(token); setFailed(false); },
      "expired-callback": () => onToken(""),
      "error-callback": fail,
    });
    widget.current = { api, id };
    return () => {
      api.remove(id);
      widget.current = null;
    };
  }, [ready, siteKey, onToken]);

  useEffect(() => {
    const active = widget.current;
    if (active) active.api.reset(active.id);
  }, [resetOn]);

  return (
    <>
      <Script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
        onReady={() => setReady(true)}
        onError={() => setFailed(true)}
      />
      <div ref={container} />
      {failed && <p role="alert" className="rp-alert">Verification failed. Reload this page to try again.</p>}
    </>
  );
}
