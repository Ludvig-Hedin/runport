import { NextResponse, type NextRequest } from "next/server";
import { sitePassword } from "@/lib/config";
import { allowed } from "@/lib/rate-limit";
import { UNLOCK_MAX_AGE, safeEqual, safeNextPath, unlockCookieName, unlockToken } from "@/lib/site-lock";

// The unlock form posts here, a plain route rather than a server action.
// While the site is locked the proxy refuses every server action, so no
// other action can be reached through the open /unlock page.

const back = (request: NextRequest, next: string, error?: string) => {
  const url = new URL("/unlock", request.url);
  url.searchParams.set("next", next);
  if (error) url.searchParams.set("error", error);
  return NextResponse.redirect(url, 303);
};

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const next = safeNextPath(String(form.get("next") ?? ""));
  const expected = sitePassword();
  if (!expected) return NextResponse.redirect(new URL(next, request.url), 303);
  const password = String(form.get("password") ?? "");
  if (!password) return back(request, next, "empty");
  if (!(await allowed("unlock"))) return back(request, next, "limited");
  // Comparing the two HMACs keeps the check constant-time for any password length.
  const [given, wanted] = await Promise.all([unlockToken(password), unlockToken(expected)]);
  if (!safeEqual(given, wanted)) return back(request, next, "wrong");
  const response = NextResponse.redirect(new URL(next, request.url), 303);
  response.cookies.set(unlockCookieName(), wanted, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: UNLOCK_MAX_AGE,
  });
  return response;
}
