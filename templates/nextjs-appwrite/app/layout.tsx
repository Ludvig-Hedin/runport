import type { Metadata } from "next";
import { headers } from "next/headers";
import { connection } from "next/server";
import { browserClient, browserGrant } from "@/lib/browser-admission";
import { siteMetadata } from "@/lib/seo";
import { ConsentProvider } from "@/components/consent/consent";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  // Read the env per request, so a build never bakes in the wrong answer.
  await connection();
  return siteMetadata();
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const key = process.env.RUNPORT_ERROR_TOKEN;
  const client = key && process.env.RUNPORT_ERROR_URL
    ? browserClient(await headers(), Boolean(process.env.RAILWAY_ENVIRONMENT_ID))
    : undefined;
  return (
    <html lang="en">
      {key && client && <head><meta name="runport-error-grant" content={browserGrant(key, client)} /></head>}
      <body className="min-h-dvh bg-neutral-50 text-neutral-900 antialiased dark:bg-neutral-950 dark:text-neutral-100">
        <ConsentProvider>{children}</ConsentProvider>
      </body>
    </html>
  );
}
