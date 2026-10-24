import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthForm } from "../auth-form";
import { AuthShell } from "../auth-ui";
import { CodeForm } from "./code-form";
import { OAuthButtons } from "./oauth-buttons";
import { signIn } from "@/lib/auth";
import { authMode, oauthProviders } from "@/lib/config";
import { readPendingLogin } from "@/lib/login-code";
import { getUser } from "@/lib/session";

type Props = { searchParams: Promise<{ error?: string; reset?: string }> };

const OAUTH_FAILED = "Sign-in was cancelled or did not work. Try again.";

export default async function LoginPage({ searchParams }: Props) {
  if (await getUser()) redirect("/items");
  const params = await searchParams;
  const error = params.error === "oauth" ? OAUTH_FAILED : undefined;
  const oauth = <OAuthButtons providers={oauthProviders()} />;

  if (authMode() === "password") {
    const notice = params.reset ? "Password changed. Sign in with your new password." : undefined;
    return (
      <AuthForm
        title="Sign in"
        submitLabel="Sign in"
        action={signIn}
        initial={{ error, notice }}
        switchHref="/signup"
        switchLabel="No account yet? Sign up"
      >
        <Link href="/forgot" className="text-sm underline">
          Forgot password?
        </Link>
        {oauth}
      </AuthForm>
    );
  }

  const pending = await readPendingLogin();
  return (
    <AuthShell title="Sign in">
      <CodeForm initial={pending ? { step: "code", email: pending.email, error } : { step: "email", error }}>
        {oauth}
      </CodeForm>
    </AuthShell>
  );
}
