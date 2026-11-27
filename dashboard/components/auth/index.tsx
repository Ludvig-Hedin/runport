import "server-only";
import { authMode, oauthProviders } from "@/lib/config";
import { readPendingLogin } from "@/lib/login-code";
import { getUser } from "@/lib/session";
import { type Appearance, resolveAppearance } from "./appearance";
import { AuthCard, Message } from "./card";
import { SubmitButton } from "./controls";
import { CodeSignInForm, ForgotPasswordForm, PasswordSignInForm, PasswordSignUpForm, ResetPasswordForm } from "./forms";
import { UserButtonMenu } from "./user-button";

// Ready-made auth screens, used like Clerk's components:
//   <SignIn />  <SignUp />  <ForgotPassword />  <ResetPassword />  <UserButton />
//   <SignedIn>…</SignedIn>  <SignedOut>…</SignedOut>
// Style them all in runport.config.ts, or one at a time with `appearance`.

export type { Appearance } from "./appearance";

type WithAppearance = { appearance?: Appearance };

/** The sign-in screen. Email code or password, per AUTH_MODE, plus any social buttons. */
export async function SignIn({ appearance, error, notice }: WithAppearance & { error?: string; notice?: string }) {
  const providers = oauthProviders();
  if (authMode() === "password") {
    return <PasswordSignInForm appearance={appearance} providers={providers} initial={{ error, notice }} />;
  }
  const pending = await readPendingLogin();
  return (
    <CodeSignInForm
      appearance={appearance}
      providers={providers}
      initial={pending ? { step: "code", email: pending.email, error } : { step: "email", error }}
    />
  );
}

/** The create-account screen. With email codes, sign-in creates accounts, so use <SignIn /> instead. */
export function SignUp({ appearance }: WithAppearance) {
  return <PasswordSignUpForm appearance={appearance} providers={oauthProviders()} />;
}

export function ForgotPassword({ appearance }: WithAppearance) {
  return <ForgotPasswordForm appearance={appearance} />;
}

/** Opened from the reset email, which carries userId and secret in the link. */
export function ResetPassword({ appearance, userId, secret }: WithAppearance & { userId?: string; secret?: string }) {
  return <ResetPasswordForm appearance={appearance} userId={userId} secret={secret} />;
}

/** The password screen of a locked site. A plain form post, so it works before any script loads. */
export function SiteUnlock({ appearance, next, error }: WithAppearance & { next: string; error?: string }) {
  const { cls } = resolveAppearance(appearance);
  return (
    <AuthCard appearance={appearance} title="Enter password" subtitle="This site is private. Enter the password to continue.">
      <form method="post" action="/unlock/submit" className={cls("form")}>
        <input type="hidden" name="next" value={next} />
        <div className="rp-field">
          <label htmlFor="site-password" className={cls("label")}>Password</label>
          <input id="site-password" name="password" type="password" required autoFocus autoComplete="current-password"
            aria-invalid={!!error || undefined} className={cls("input")} />
        </div>
        <Message appearance={appearance} error={error} />
        <SubmitButton appearance={appearance}>Unlock</SubmitButton>
      </form>
    </AuthCard>
  );
}

/** The signed-in person's avatar with an account menu. Renders nothing when signed out. */
export async function UserButton({ appearance }: WithAppearance) {
  const user = await getUser();
  if (!user) return null;
  return <UserButtonMenu name={user.name} email={user.email} appearance={appearance} />;
}

export async function SignedIn({ children }: { children: React.ReactNode }) {
  return (await getUser()) ? <>{children}</> : null;
}

export async function SignedOut({ children }: { children: React.ReactNode }) {
  return (await getUser()) ? null : <>{children}</>;
}
