"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

/** Reloads the page's data without a full reload. */
export function RetryButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button type="button" className="db-btn db-btn-sm db-btn-secondary" disabled={pending} onClick={() => start(() => router.refresh())}>
      {pending ? "Trying…" : "Try again"}
    </button>
  );
}

export function BlockError({ what }: { what: string }) {
  return (
    <div className="db-block-error" role="alert">
      <p>Couldn’t load {what}.</p>
      <RetryButton />
    </div>
  );
}
