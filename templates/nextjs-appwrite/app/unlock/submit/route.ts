import { NextResponse, type NextRequest } from "next/server";
import { sitePassword } from "@/lib/config";
import { UNLOCK_FAILURES, allowed, release, take } from "@/lib/rate-limit";
import { UNLOCK_MAX_AGE, safeEqual, safeNextPath, unlockCookieName, unlockToken } from "@/lib/site-lock";

// The unlock form posts here, a plain route rather than a server action.
// While the site is locked the proxy refuses every server action, so no
// other action can be reached through the open /unlock page.

// A relative Location stays on the public origin behind a reverse proxy.
const redirect = (location: string) => new NextResponse(null, { status: 303, headers: { Location: location } });

const back = (next: string, error: string) => {
  const query = new URLSearchParams({ next, error });
  return redirect(`/unlock?${query}`);
};

// A password and a return path fit easily; anything larger is not our form.
const MAX_BODY = 4096;

export async function POST(request: NextRequest) {
  const length = Number(request.headers.get("content-length"));
  const urlencoded = request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded");
  if (!urlencoded || !Number.isFinite(length) || length <= 0 || length > MAX_BODY) {
    return new NextResponse("Bad request", { status: 400 });
  }
  // Counted before reading the body, so floods cost as little as possible.
  if (!(await allowed("unlock"))) return back("/", "limited");
  const form = new URLSearchParams((await request.text()).slice(0, MAX_BODY));
  const next = safeNextPath(form.get("next"));
  const expected = sitePassword();
  if (!expected) return redirect(next);
  const password = form.get("password") ?? "";
  if (!password) return back(next, "empty");
  // Comparing the two HMACs keeps the check constant-time for any password length.
  if (!take(...UNLOCK_FAILURES)) return back(next, "limited");
  const [given, wanted] = await Promise.all([unlockToken(password), unlockToken(expected)]);
  if (!safeEqual(given, wanted)) return back(next, "wrong");
  release(UNLOCK_FAILURES[0]);
  const response = redirect(next);
  response.cookies.set(unlockCookieName(), wanted, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: UNLOCK_MAX_AGE,
  });
  return response;
}
