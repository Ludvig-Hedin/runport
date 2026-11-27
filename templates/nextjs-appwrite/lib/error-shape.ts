// Project errors onto code locations and fixed labels. Error messages, request
// URLs, headers, cookies and rejection values are never part of the report.
export const errorKinds = [
  "Error", "TypeError", "ReferenceError", "SyntaxError", "RangeError", "URIError", "EvalError", "AggregateError",
] as const;
type Source = "render" | "route" | "action" | "proxy" | "browser";

function browserLocation(line: string, origin: string): string | undefined {
  const match = line.match(/(https?:\/\/[^\s()]+\/\_next\/static\/chunks\/[\w./-]+\.js):(\d{1,9}):(\d{1,9})\)?$/);
  if (!match) return;
  try {
    const url = new URL(match[1]);
    if (url.origin === origin && !url.search && !url.hash && !url.username && !url.password) {
      return [url.pathname, match[2], match[3]].join(":");
    }
  } catch {
    // Ignore malformed or third-party frames.
  }
}

function serverLocation(line: string): string | undefined {
  return line.match(/(?:^|[/ (])((?:\.next\/)?server\/[\w./()[\]@-]+\.[cm]?js:\d{1,9}:\d{1,9})\)?$/)?.[1];
}

export async function errorReport(source: Source, name: unknown, stack: unknown, route = "", origin = "") {
  const kind = errorKinds.find((known) => known === name) ?? "Error";
  const frames = (typeof stack === "string" ? stack.slice(0, 8192) : "").split("\n").slice(0, 30)
    .filter((line) => /^\s*at\s|^[\w.$<>]*@https?:\/\//.test(line))
    .flatMap((line) => {
      const location = source === "browser" ? browserLocation(line, origin) : serverLocation(line);
      return location ? [location] : [];
    }).slice(0, 3);
  // route is Next's route template, never the URL a visitor requested.
  const key = JSON.stringify([source, kind, route.slice(0, 256), frames]);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const fingerprint = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { source, kind, fingerprint };
}
