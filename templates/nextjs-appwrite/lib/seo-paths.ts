export type SitemapLink = { path: string; lastModified?: string | Date };

export function siteOrigin(value: string): URL {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error("APP_URL must be a site origin, such as https://example.com.");
  }
  return url;
}

export function publicPagePath(file: string): string | null {
  const parts = file.split("/");
  if (!/^page\.(tsx?|jsx?|mdx?)$/.test(parts.pop() ?? "") || !parts.includes("(public)")) return null;
  const group = /^\([\w-]+\)$/;
  const segment = /^[\p{L}\p{N}_-][\p{L}\p{N}._~-]*$/u;
  if (parts.some((part) => !group.test(part) && (!segment.test(part) || part.startsWith("_")))) return null;
  return "/" + parts.filter((part) => !group.test(part)).map(encodeURIComponent).join("/");
}

export function canonicalUrl(origin: URL, path: string): string | null {
  if (!path.startsWith("/") || path.startsWith("//") || /[?#\\\s]/u.test(path)) return null;
  try {
    const normalized = path.replace(/\/+$/, "").split("/").map((segment) => {
      const decoded = decodeURIComponent(segment);
      if (decoded === "." || decoded === ".." || /[/\\\u0000-\u001f\u007f]/u.test(decoded)) throw new Error();
      return encodeURIComponent(decoded);
    }).join("/");
    return new URL(normalized || "/", origin).href;
  } catch {
    return null;
  }
}

export function sitemapEntries(origin: URL, paths: readonly string[], links: readonly SitemapLink[]) {
  const entries = new Map<string, { url: string; lastModified?: string | Date }>();
  for (const { path, lastModified } of [...paths.map((path): SitemapLink => ({ path })), ...links]) {
    const url = canonicalUrl(origin, path);
    if (!url || entries.has(url) && !lastModified) continue;
    entries.set(url, { url, ...(lastModified ? { lastModified } : {}) });
  }
  return [...entries.values()];
}
