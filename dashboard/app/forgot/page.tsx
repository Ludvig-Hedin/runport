import { redirect } from "next/navigation";
import { ForgotPassword } from "@/components/auth";
import { authMode } from "@/lib/config";
import { getUser } from "@/lib/session";
import { routes } from "@/runport.config";

export default async function ForgotPage() {
  if (authMode() !== "password") redirect("/login");
  if (await getUser()) redirect(routes.afterSignIn);
  return <ForgotPassword />;
}
