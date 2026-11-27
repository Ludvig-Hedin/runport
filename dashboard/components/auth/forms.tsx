"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import { type FormState, requestReset, resetPassword, signIn, signUp } from "@/lib/auth";
import { type CodeState, emailCode } from "@/lib/code-auth";
import type { OAuthProviderId } from "@/lib/config";
import { appName } from "@/runport.config";
import { type Appearance, resolveAppearance } from "./appearance";
import { AuthCard, Divider, Message } from "./card";
import { CodeInput, Field, PasswordField, SubmitButton, useCooldown } from "./controls";
import { SocialButtons } from "./social-buttons";

// The client side of the auth screens. Pages use the wrappers in index.tsx.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Shared = { appearance?: Appearance; providers?: OAuthProviderId[] };

/** Puts social buttons above or below the form, as appearance.layout says. */
function WithSocial({ appearance, providers = [], children }: Shared & { children: React.ReactNode }) {
  const placement = resolveAppearance(appearance).layout.socialButtonsPlacement;
  if (providers.length === 0) return <>{children}</>;
  const social = <SocialButtons providers={providers} appearance={appearance} />;
  return placement === "top" ? (
    <>
      {social}
      <Divider appearance={appearance} />
      {children}
    </>
  ) : (
    <>
      {children}
      <Divider appearance={appearance} />
      {social}
    </>
  );
}

function FooterLink({ appearance, text, href, label }: { appearance?: Appearance; text: string; href: string; label: string }) {
  return (
    <>
      {text}{" "}
      <Link href={href} className={resolveAppearance(appearance).cls("link")}>
        {label}
      </Link>
    </>
  );
}

export function PasswordSignInForm({ appearance, providers, initial }: Shared & { initial?: FormState }) {
  const [state, action] = useActionState(signIn, initial ?? {});
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { cls } = resolveAppearance(appearance);
  return (
    <AuthCard
      appearance={appearance}
      title={`Sign in to ${appName}`}
      subtitle="Welcome back. Sign in to continue."
      footer={<FooterLink appearance={appearance} text="No account yet?" href="/signup" label="Sign up" />}
    >
      <WithSocial appearance={appearance} providers={providers}>
        <form action={action} className={cls("form")}>
          <Field appearance={appearance} label="Email address" name="email" type="email" required autoComplete="email"
            value={email} onChange={(e) => setEmail(e.target.value)} />
          <PasswordField appearance={appearance} label="Password" name="password" required autoComplete="current-password"
            value={password} onChange={(e) => setPassword(e.target.value)}
            aside={<Link href="/forgot" className={cls("link")}>Forgot password?</Link>} />
          <Message appearance={appearance} error={state.error} notice={state.notice} />
          <SubmitButton appearance={appearance} ready={EMAIL.test(email.trim()) && password.length > 0}>
            Continue
          </SubmitButton>
        </form>
      </WithSocial>
    </AuthCard>
  );
}

export function PasswordSignUpForm({ appearance, providers }: Shared) {
  const [state, action] = useActionState(signUp, {});
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const { cls } = resolveAppearance(appearance);
  return (
    <AuthCard
      appearance={appearance}
      title="Create your account"
      subtitle={`Get started with ${appName}.`}
      footer={<FooterLink appearance={appearance} text="Already have an account?" href="/login" label="Sign in" />}
    >
      <WithSocial appearance={appearance} providers={providers}>
        <form action={action} className={cls("form")}>
          <Field appearance={appearance} label="Name" name="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
          <Field appearance={appearance} label="Email address" name="email" type="email" required autoComplete="email"
            value={email} onChange={(e) => setEmail(e.target.value)} />
          <PasswordField appearance={appearance} label="Password" name="password" required minLength={8} autoComplete="new-password"
            value={password} onChange={(e) => setPassword(e.target.value)}
            aside={<span className="rp-hint">At least 8 characters</span>} />
          <Message appearance={appearance} error={state.error} notice={state.notice} />
          <SubmitButton appearance={appearance} ready={EMAIL.test(email.trim()) && password.length >= 8}>
            Create account
          </SubmitButton>
        </form>
      </WithSocial>
    </AuthCard>
  );
}

const RESEND_AFTER = 30;

export function CodeSignInForm({ appearance, providers, initial }: Shared & { initial: CodeState }) {
  const [state, action] = useActionState(emailCode, initial);
  const [email, setEmail] = useState(initial.email ?? "");
  const [code, setCode] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const verifyRef = useRef<HTMLButtonElement>(null);
  const { cls } = resolveAppearance(appearance);
  // A new state object means the server answered: clear a rejected code.
  useEffect(() => {
    if (state.error) setCode("");
    if (state.step === "email" && state.email) setEmail(state.email);
  }, [state]);
  // Restart the resend timer when a code goes out, not when a code is rejected.
  const [sends, setSends] = useState(0);
  useEffect(() => {
    if (state.step === "code" && !state.error) setSends((n) => n + 1);
  }, [state]);
  const cooldown = useCooldown(RESEND_AFTER, sends);
  // Submit on its own once six digits are in, but only once per code, so a
  // rejected code does not loop.
  const autoSent = useRef("");
  useEffect(() => {
    if (code.length !== 6 || autoSent.current === code) return;
    autoSent.current = code;
    formRef.current?.requestSubmit(verifyRef.current);
  }, [code]);

  if (state.step === "email") {
    return (
      <AuthCard appearance={appearance} title={`Sign in to ${appName}`} subtitle="Enter your email and we'll send you a code.">
        <WithSocial appearance={appearance} providers={providers}>
          <form key="email" action={action} className={cls("form")}>
            <Field appearance={appearance} label="Email address" name="email" type="email" required autoComplete="email"
              value={email} onChange={(e) => setEmail(e.target.value)} invalid={!!state.error} />
            <Message appearance={appearance} error={state.error} notice={state.notice} />
            <SubmitButton appearance={appearance} name="intent" value="send" ready={EMAIL.test(email.trim())}>
              Continue
            </SubmitButton>
          </form>
        </WithSocial>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      appearance={appearance}
      title="Check your email"
      subtitle={<>Enter the 6-digit code we sent to <strong>{state.email}</strong>.</>}
    >
      {/* The first submit button is the one Enter presses, so "Continue" comes first. */}
      <form key="code" ref={formRef} action={action} className={cls("form")}>
        <CodeInput appearance={appearance} value={code} onChange={setCode} invalid={!!state.error && code.length === 0} />
        <Message appearance={appearance} error={state.error} notice={state.notice} />
        <SubmitButton ref={verifyRef} appearance={appearance} name="intent" value="verify" ready={code.length === 6}>
          Continue
        </SubmitButton>
        <div className="rp-row">
          <SubmitButton appearance={appearance} name="intent" value="resend" formNoValidate disabled={cooldown > 0} variant="link">
            {cooldown > 0 ? `Send a new code in ${cooldown} s` : "Send a new code"}
          </SubmitButton>
          <SubmitButton appearance={appearance} name="intent" value="restart" formNoValidate variant="link">
            Use a different email
          </SubmitButton>
        </div>
      </form>
    </AuthCard>
  );
}

export function ForgotPasswordForm({ appearance }: { appearance?: Appearance }) {
  const [state, action] = useActionState(requestReset, {});
  const [email, setEmail] = useState("");
  const { cls } = resolveAppearance(appearance);
  return (
    <AuthCard
      appearance={appearance}
      title="Reset password"
      subtitle="Enter your email and we'll send you a link."
      footer={<Link href="/login" className={cls("link")}>Back to sign in</Link>}
    >
      <form action={action} className={cls("form")}>
        <Field appearance={appearance} label="Email address" name="email" type="email" required autoComplete="email"
          value={email} onChange={(e) => setEmail(e.target.value)} />
        <Message appearance={appearance} error={state.error} notice={state.notice} />
        <SubmitButton appearance={appearance} ready={EMAIL.test(email.trim())}>Send link</SubmitButton>
      </form>
    </AuthCard>
  );
}

export function ResetPasswordForm({ appearance, userId, secret }: { appearance?: Appearance; userId?: string; secret?: string }) {
  const [state, action] = useActionState(resetPassword, {});
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const { cls } = resolveAppearance(appearance);
  const mismatch = confirm.length > 0 && confirm !== password;
  return (
    <AuthCard
      appearance={appearance}
      title="Choose a new password"
      subtitle="Use at least 8 characters."
      footer={<Link href="/forgot" className={cls("link")}>Send a new link</Link>}
    >
      {userId && secret ? (
        <form action={action} className={cls("form")}>
          <input type="hidden" name="userId" value={userId} />
          <input type="hidden" name="secret" value={secret} />
          <PasswordField appearance={appearance} label="New password" name="password" required minLength={8} autoComplete="new-password"
            value={password} onChange={(e) => setPassword(e.target.value)} />
          <PasswordField appearance={appearance} label="Repeat new password" name="confirm" required minLength={8} autoComplete="new-password"
            value={confirm} onChange={(e) => setConfirm(e.target.value)} invalid={mismatch} />
          <Message appearance={appearance} error={state.error ?? (mismatch ? "The passwords do not match." : undefined)} notice={state.notice} />
          <SubmitButton appearance={appearance} ready={password.length >= 8 && confirm === password}>Save password</SubmitButton>
        </form>
      ) : (
        <Message appearance={appearance} error="This reset link is not valid. Ask for a new one." />
      )}
    </AuthCard>
  );
}
