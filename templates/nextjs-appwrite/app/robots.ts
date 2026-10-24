import type { MetadataRoute } from "next";
import { indexingAllowed } from "@/lib/config";

// Read the env on each request, not once at build time.
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: indexingAllowed() ? { userAgent: "*", allow: "/" } : { userAgent: "*", disallow: "/" },
  };
}
