import "server-only";
import type { SitemapLink } from "@/lib/seo-paths";

/** Return concrete paths from your published content here. */
export async function additionalSitemapUrls(): Promise<SitemapLink[]> {
  return [];
}
