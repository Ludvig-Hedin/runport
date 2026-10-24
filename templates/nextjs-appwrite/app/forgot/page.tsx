import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthShell } from "../auth-ui";
import { ForgotForm } from "./forgot-form";
import { authMode } from "@/lib/config";
import { getUser } from "@/lib/session";

export default async function ForgotPage() {
  if (authMode() !== "password") redirect("/login");
  if (await getUser()) redirect("/items");
  return (
    <AuthShell title="Reset password">
      <ForgotForm />
      <Link href="/login" className="text-sm underline">
        Back to sign in
      </Link>
    </AuthShell>
  );
}
