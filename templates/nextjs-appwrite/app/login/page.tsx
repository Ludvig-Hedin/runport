import { AuthForm } from "../auth-form";
import { signIn } from "@/lib/auth";

export default function LoginPage() {
  return (
    <AuthForm title="Sign in" submitLabel="Sign in" action={signIn} switchHref="/signup" switchLabel="No account yet? Sign up" />
  );
}
