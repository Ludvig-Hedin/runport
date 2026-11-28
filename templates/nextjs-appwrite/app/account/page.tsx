import { redirect } from "next/navigation";
import { UserProfile } from "@/components/auth";
import { getUser } from "@/lib/session";

export default async function AccountPage() {
  if (!(await getUser())) redirect("/login");
  return <UserProfile />;
}
