import type { Metadata } from "next";
import { connection } from "next/server";
import { siteMetadata } from "@/lib/seo";
import { ConsentProvider } from "@/components/consent/consent";
import { VisitorAnalytics } from "./visitor-analytics";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  // Read the env per request, so a build never bakes in the wrong answer.
  await connection();
  return siteMetadata();
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-neutral-50 text-neutral-900 antialiased dark:bg-neutral-950 dark:text-neutral-100">
        <ConsentProvider>{children}</ConsentProvider>
        <VisitorAnalytics />
      </body>
    </html>
  );
}
