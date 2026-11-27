import { seoOrigin } from "@/lib/seo";
import { appName, seo } from "@/runport.config";

export function JsonLd({ data }: { data: Record<string, unknown> }) {
  const json = JSON.stringify({ "@context": "https://schema.org", ...data }).replace(/</g, "\\u003c");
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}

export function WebsiteJsonLd() {
  const url = seoOrigin().href;
  const organizationId = new URL("#organization", url).href;
  return (
    <JsonLd data={{
      "@graph": [
        {
          "@type": "WebSite",
          "@id": new URL("#website", url).href,
          name: appName,
          url,
          description: seo.description,
          ...(seo.organization && { publisher: { "@id": organizationId } }),
        },
        ...(seo.organization ? [{ "@type": "Organization", "@id": organizationId, url, ...seo.organization }] : []),
      ],
    }} />
  );
}
