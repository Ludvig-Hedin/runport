import { NextResponse, type NextRequest } from "next/server";
import { indexingAllowed, sitePassword } from "@/lib/config";
import { safeEqual, unlockCookieName, unlockToken } from "@/lib/site-lock";

// Runs before every page and route. It locks the site when SITE_PASSWORD is
// set and tells search engines to stay away unless indexing is allowed.

const OPEN_PATHS = new Set(["/unlock", "/unlock/submit", "/robots.txt", "/favicon.ico", "/manifest.webmanifest"]);
const ICON_PATH = /^\/(apple-)?icon\d*(\.\w+)?$/;

function isOpen(pathname: string): boolean {
  return OPEN_PATHS.has(pathname) || pathname.startsWith("/_next/") || ICON_PATH.test(pathname);
}

async function isUnlocked(request: NextRequest, password: string): Promise<boolean> {
  const cookie = request.cookies.get(unlockCookieName())?.value;
  return !!cookie && safeEqual(cookie, await unlockToken(password));
}

function withRobots(response: NextResponse): NextResponse {
  if (!indexingAllowed()) response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}

export async function proxy(request: NextRequest) {
  const password = sitePassword();
  const { pathname, search } = request.nextUrl;
  const locked = password ? !(await isUnlocked(request, password)) : false;
  // Server actions can be posted to any path, the open ones included, so a
  // locked site refuses them all. The unlock form uses a plain route instead.
  if (locked && request.headers.has("next-action")) {
    return withRobots(new NextResponse("Locked", { status: 403 }));
  }
  if (locked && !isOpen(pathname)) {
    const unlock = request.nextUrl.clone();
    unlock.pathname = "/unlock";
    unlock.search = `?next=${encodeURIComponent(pathname + search)}`;
    return withRobots(NextResponse.redirect(unlock));
  }
  return withRobots(NextResponse.next());
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
