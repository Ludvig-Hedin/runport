"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { FormState } from "@/lib/auth";
import { AuthShell, FormMessage, field, primaryButton } from "./auth-ui";

type Props = {
  title: string;
  submitLabel: string;
  action: (state: FormState, form: FormData) => Promise<FormState>;
  withName?: boolean;
  switchHref: string;
  switchLabel: string;
  /** A message from the page, such as a failed Google sign-in. */
  initial?: FormState;
  children?: React.ReactNode;
};

export function AuthForm({ title, submitLabel, action, withName, switchHref, switchLabel, initial, children }: Props) {
  const [state, formAction, pending] = useActionState(action, initial ?? {});
  return (
    <AuthShell title={title}>
      <form action={formAction} className="flex flex-col gap-3">
        {withName && <input name="name" placeholder="Name" autoComplete="name" className={field} />}
        <input name="email" type="email" required placeholder="Email" autoComplete="email" className={field} />
        <input
          name="password"
          type="password"
          required
          minLength={8}
          placeholder="Password"
          autoComplete={withName ? "new-password" : "current-password"}
          className={field}
        />
        <FormMessage error={state.error} notice={state.notice} />
        <button disabled={pending} className={primaryButton}>
          {pending ? "Working…" : submitLabel}
        </button>
      </form>
      {children}
      <Link href={switchHref} className="text-sm underline">
        {switchLabel}
      </Link>
    </AuthShell>
  );
}
