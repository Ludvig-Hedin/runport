import "server-only";
import type { Metadata } from "next";
import { connection } from "next/server";
import { appUrl, indexingAllowed } from "@/lib/config";
import { canonicalUrl, siteOrigin } from "@/lib/seo-paths";
import { appName, seo } from "@/runport.config";

type PageSeo = { title?: string; description?: string; path: string; noindex?: boolean };

export function seoOrigin(): URL {
  return siteOrigin(appUrl());
}

export function siteMetadata(): Metadata {
  return {
    metadataBase: seoOrigin(),
    title: { default: appName, template: `%s | ${appName}` },
    description: seo.description,
    robots: { index: false, follow: false },
    ...socialMetadata(appName, seo.description),
  };
}

function socialMetadata(title: string, description?: string, url?: string): Metadata {
  const image = { url: "/opengraph-image", width: 1200, height: 630, alt: appName };
  return {
    openGraph: { type: "website", siteName: appName, title, description, url, images: [image] },
    twitter: { card: "summary_large_image", title, description, images: [image] },
  };
}

export async function pageMetadata(page: PageSeo): Promise<Metadata> {
  await connection();
  const canonical = canonicalUrl(seoOrigin(), page.path);
  if (!canonical) throw new Error(`Invalid canonical path: ${page.path}`);
  const description = page.description ?? seo.description;
  const visible = indexingAllowed() && !page.noindex;
  return {
    title: page.title,
    description,
    alternates: { canonical },
    robots: { index: visible, follow: visible },
    ...socialMetadata(page.title ? `${page.title} | ${appName}` : appName, description, canonical),
  };
}
