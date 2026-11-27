import "server-only";
import { authMode, oauthProviders } from "@/lib/config";
import { readPendingLogin } from "@/lib/login-code";
import { getUser } from "@/lib/session";
import { type Appearance, resolveAppearance } from "./appearance";
import { AuthCard, Message } from "./card";
import { SubmitButton } from "./controls";
import { CodeSignInForm, ForgotPasswordForm, PasswordSignInForm, PasswordSignUpForm, ResetPasswordForm } from "./forms";
import { UserButtonMenu } from "./user-button";
import { type DeviceInfo, UserProfileView } from "./user-profile";
import { createSessionClient } from "@/lib/appwrite";
import { routes } from "@/runport.config";

// Ready-made auth screens, used like Clerk's components:
//   <SignIn />  <SignUp />  <ForgotPassword />  <ResetPassword />  <UserButton />  <UserProfile />
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
      initial={pending ? { step: "code", email: pending.email, error, notice } : { step: "email", error, notice }}
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

/** The account page: name, password, signed-in devices and account deletion. Null when signed out. */
export async function UserProfile({ appearance }: WithAppearance) {
  const user = await getUser();
  if (!user) return null;
  let devices: DeviceInfo[] | null = null;
  try {
    const { account } = await createSessionClient();
    const { sessions } = await account.listSessions();
    devices = sessions
      .sort((a, b) => Number(b.current) - Number(a.current) || b.$createdAt.localeCompare(a.$createdAt))
      .map((s) => ({
        id: s.$id,
        label: [[s.clientName, s.clientVersion?.split(".")[0]].filter(Boolean).join(" "), s.osName].filter(Boolean).join(" on ") || "Unknown device",
        // Sessions are created on the server, so Appwrite's location is the
        // server's, not the visitor's. The browser formats the time locally.
        signedInAt: s.$createdAt,
        current: s.current,
      }));
  } catch {
    // null shows "couldn't load devices" with a retry; the rest of the page still works.
  }
  return (
    <UserProfileView
      appearance={appearance}
      name={user.name}
      email={user.email}
      passwordMode={authMode() === "password"}
      devices={devices}
      backHref={routes.afterSignIn}
    />
  );
}
