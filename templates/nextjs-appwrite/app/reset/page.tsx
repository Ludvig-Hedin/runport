import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthShell, FormMessage } from "../auth-ui";
import { ResetForm } from "./reset-form";
import { authMode } from "@/lib/config";

type Props = { searchParams: Promise<{ userId?: string; secret?: string }> };

// The link in the reset email opens this page with userId and secret in the query.
export default async function ResetPage({ searchParams }: Props) {
  if (authMode() !== "password") redirect("/login");
  const { userId, secret } = await searchParams;
  return (
    <AuthShell title="Choose a new password">
      {userId && secret ? (
        <ResetForm userId={userId} secret={secret} />
      ) : (
        <FormMessage error="This reset link is not valid. Ask for a new one." />
      )}
      <Link href="/forgot" className="text-sm underline">
        Send a new link
      </Link>
    </AuthShell>
  );
}
