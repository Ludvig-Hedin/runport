"use client";

import { useActionState } from "react";
import { resetPassword } from "@/lib/auth";
import { FormMessage, field, primaryButton } from "../auth-ui";

export function ResetForm({ userId, secret }: { userId: string; secret: string }) {
  const [state, action, pending] = useActionState(resetPassword, {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="secret" value={secret} />
      <input
        name="password"
        type="password"
        required
        minLength={8}
        placeholder="New password"
        autoComplete="new-password"
        className={field}
      />
      <input
        name="confirm"
        type="password"
        required
        minLength={8}
        placeholder="Repeat new password"
        autoComplete="new-password"
        className={field}
      />
      <FormMessage error={state.error} notice={state.notice} />
      <button disabled={pending} className={primaryButton}>
        {pending ? "Working…" : "Save password"}
      </button>
    </form>
  );
}
