import { redirect } from "next/navigation";
import { SignUp } from "@/components/auth";
import { authMode } from "@/lib/config";
import { getUser } from "@/lib/session";
import { routes } from "@/runport.config";

export default async function SignupPage() {
  // With email codes, the sign-in page creates new accounts too.
  if (authMode() !== "password") redirect("/login");
  if (await getUser()) redirect(routes.afterSignIn);
  return <SignUp />;
}
