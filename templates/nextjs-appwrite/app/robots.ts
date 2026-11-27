import type { MetadataRoute } from "next";
import { indexingAllowed } from "@/lib/config";
import { seoOrigin } from "@/lib/seo";

// Read the env on each request, so preview and lock rules apply at runtime.
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  if (!indexingAllowed()) return { rules: { userAgent: "*", disallow: "/" } };
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: new URL("/sitemap.xml", seoOrigin()).href,
  };
}
