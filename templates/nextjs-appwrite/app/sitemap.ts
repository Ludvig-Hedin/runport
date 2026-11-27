import type { MetadataRoute } from "next";
import { indexingAllowed } from "@/lib/config";
import { seoOrigin } from "@/lib/seo";
import { sitemapEntries } from "@/lib/seo-paths";
import { additionalSitemapUrls } from "@/lib/sitemap-urls";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  if (!indexingAllowed()) return [];
  const discovered: string[] = JSON.parse(process.env.RUNPORT_PUBLIC_PAGES ?? "[]");
  return sitemapEntries(seoOrigin(), discovered, await additionalSitemapUrls());
}
