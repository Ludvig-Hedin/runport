import { AuthForm } from "../auth-form";
import { signUp } from "@/lib/auth";

export default function SignupPage() {
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
