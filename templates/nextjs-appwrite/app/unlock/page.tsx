import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AuthShell } from "../auth-ui";
import { UnlockForm } from "./unlock-form";
import { sitePassword } from "@/lib/config";
import { safeEqual, safeNextPath, unlockCookieName, unlockToken } from "@/lib/site-lock";

import { TOO_MANY_ATTEMPTS } from "@/lib/auth-errors";

type Props = { searchParams: Promise<{ next?: string; error?: string }> };

const ERRORS: Record<string, string> = {
  empty: "Enter the password.",
  wrong: "Wrong password.",
  limited: TOO_MANY_ATTEMPTS,
};

export default async function UnlockPage({ searchParams }: Props) {
  const params = await searchParams;
  const next = safeNextPath(params.next);
  const password = sitePassword();
  if (!password) redirect(next);
  const cookie = (await cookies()).get(unlockCookieName())?.value;
  if (cookie && safeEqual(cookie, await unlockToken(password))) redirect(next);
  return (
    <AuthShell title="Enter password">
      <UnlockForm next={next} error={params.error ? ERRORS[params.error] : undefined} />
    </AuthShell>
  );
}
