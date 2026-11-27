import { redirect } from "next/navigation";
import { ResetPassword } from "@/components/auth";
import { authMode } from "@/lib/config";

type Props = { searchParams: Promise<{ userId?: string; secret?: string }> };

// The link in the reset email opens this page with userId and secret in the query.
export default async function ResetPage({ searchParams }: Props) {
  if (authMode() !== "password") redirect("/login");
  const { userId, secret } = await searchParams;
  return <ResetPassword userId={userId} secret={secret} />;
}
