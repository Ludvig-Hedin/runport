"use client";

import { useActionState } from "react";
import { unlock } from "./actions";
import { FormMessage, field, primaryButton } from "../auth-ui";

export function UnlockForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(unlock, {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="next" value={next} />
      <input
        name="password"
        type="password"
        required
        autoFocus
        placeholder="Password"
        autoComplete="current-password"
        className={field}
      />
      <FormMessage error={state.error} />
      <button disabled={pending} className={primaryButton}>
        {pending ? "Working…" : "Unlock"}
      </button>
    </form>
  );
}
