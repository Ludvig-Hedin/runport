import { redirect } from "next/navigation";
import { AuthForm } from "../auth-form";
import { signUp } from "@/lib/auth";
import { authMode } from "@/lib/config";
import { getUser } from "@/lib/session";

export default async function SignupPage() {
  // With email codes, the sign-in page creates new accounts too.
  if (authMode() !== "password") redirect("/login");
  if (await getUser()) redirect("/items");
  return (
    <AuthForm
      title="Create account"
      submitLabel="Sign up"
      action={signUp}
      withName
      switchHref="/login"
      switchLabel="Already have an account? Sign in"
    />
  );
}
