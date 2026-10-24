import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/appwrite";
import { takeOAuthState } from "@/lib/oauth-state";
import { setSessionCookie } from "@/lib/session";

// Appwrite sends people here after Google or GitHub sign-in, with a one-time
// token in the query. The state in the path must match the cookie set when
// this browser started the sign-in, so nobody can log a visitor into an
// account they did not choose. Then the token becomes a session in our cookie.
export async function GET(request: NextRequest, { params }: { params: Promise<{ state: string }> }) {
  const { state } = await params;
  const userId = request.nextUrl.searchParams.get("userId");
  const secret = request.nextUrl.searchParams.get("secret");
  if (!(await takeOAuthState(state)) || !userId || !secret) redirect("/login?error=oauth");
  try {
    const { account } = createAdminClient();
    await setSessionCookie(await account.createSession({ userId, secret }));
  } catch (error) {
    console.error(error);
    redirect("/login?error=oauth");
  }
  redirect("/items");
}
