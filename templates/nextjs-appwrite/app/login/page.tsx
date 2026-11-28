import { redirect } from "next/navigation";
import { SignIn } from "@/components/auth";
import { readFlash } from "@/lib/flash";
import { getUser } from "@/lib/session";
import { routes } from "@/runport.config";

type Props = { searchParams: Promise<{ error?: string; reset?: string }> };

export default async function LoginPage({ searchParams }: Props) {
  if (await getUser()) redirect(routes.afterSignIn);
  const params = await searchParams;
  const hasFlash = Boolean(await readFlash());
  return (
    <SignIn
      error={params.error === "oauth" ? "Sign-in was cancelled or did not work. Try again." : undefined}
      notice={!hasFlash && params.reset ? "Password changed. Sign in with your new password." : undefined}
      hasFlash={hasFlash}
    />
  );
}
