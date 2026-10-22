"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { FormState } from "@/lib/auth";

type Props = {
  title: string;
  submitLabel: string;
  action: (state: FormState, form: FormData) => Promise<FormState>;
  withName?: boolean;
  switchHref: string;
  switchLabel: string;
};

const field =
  "w-full rounded-md border border-neutral-300 bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900";

export function AuthForm({ title, submitLabel, action, withName, switchHref, switchLabel }: Props) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">{title}</h1>
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
        {state.error && <p role="alert" className="text-sm text-red-600">{state.error}</p>}
        <button
          disabled={pending}
          className="rounded-md bg-neutral-900 px-3 py-2 font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {pending ? "Working…" : submitLabel}
        </button>
      </form>
      <Link href={switchHref} className="text-sm underline">
        {switchLabel}
      </Link>
    </main>
  );
}
