import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AuthShell } from "../auth-ui";
import { UnlockForm } from "./unlock-form";
import { sitePassword } from "@/lib/config";
import { safeEqual, safeNextPath, unlockCookieName, unlockToken } from "@/lib/site-lock";

type Props = { searchParams: Promise<{ next?: string }> };

export default async function UnlockPage({ searchParams }: Props) {
  const next = safeNextPath((await searchParams).next);
  const password = sitePassword();
  if (!password) redirect(next);
  const cookie = (await cookies()).get(unlockCookieName())?.value;
  if (cookie && safeEqual(cookie, await unlockToken(password))) redirect(next);
  return (
    <AuthShell title="Enter password">
      <UnlockForm next={next} />
    </AuthShell>
  );
}
