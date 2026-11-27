"use client";

import { useActionState } from "react";
import { emailCode, type CodeState } from "@/lib/code-auth";
import { FormMessage, field, primaryButton } from "../auth-ui";

type Props = {
  initial: CodeState;
  /** Shown under the email step only, for Google and GitHub buttons. */
  children?: React.ReactNode;
};

export function CodeForm({ initial, children }: Props) {
  const [state, action, pending] = useActionState(emailCode, initial);

  if (state.step === "email") {
    return (
      <>
        <form key="email" action={action} className="flex flex-col gap-3">
          <input
            name="email"
            type="email"
            required
            placeholder="Email"
            autoComplete="email"
            defaultValue={state.email}
            className={field}
          />
          <FormMessage error={state.error} notice={state.notice} />
          <button name="intent" value="send" disabled={pending} className={primaryButton}>
            {pending ? "Working…" : "Send code"}
          </button>
        </form>
        {children}
      </>
    );
  }

  // The first submit button is the one Enter presses, so "Sign in" comes first.
  return (
    <form key="code" action={action} className="flex flex-col gap-3">
      <p className="text-sm">Enter the 6-digit code we sent to {state.email}.</p>
      <input
        name="code"
        required
        autoFocus
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="6-digit code"
        className={field}
      />
      <FormMessage error={state.error} notice={state.notice} />
      <button name="intent" value="verify" disabled={pending} className={primaryButton}>
        {pending ? "Working…" : "Sign in"}
      </button>
      <div className="flex justify-between gap-3 text-sm">
        <button name="intent" value="resend" formNoValidate disabled={pending} className="underline disabled:opacity-50">
          Send a new code
        </button>
        <button name="intent" value="restart" formNoValidate disabled={pending} className="underline disabled:opacity-50">
          Use a different email
        </button>
      </div>
    </form>
  );
}
