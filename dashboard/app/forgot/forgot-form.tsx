"use client";

import { useActionState } from "react";
import { requestReset } from "@/lib/auth";
import { FormMessage, field, primaryButton } from "../auth-ui";

export function ForgotForm() {
  const [state, action, pending] = useActionState(requestReset, {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <input name="email" type="email" required placeholder="Email" autoComplete="email" className={field} />
      <FormMessage error={state.error} notice={state.notice} />
      <button disabled={pending} className={primaryButton}>
        {pending ? "Working…" : "Send link"}
      </button>
    </form>
  );
}
