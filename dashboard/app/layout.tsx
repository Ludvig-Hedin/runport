import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { ConsentProvider } from "@/components/consent/consent";
import { appName } from "@/runport.config";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

// The dashboard is private: never indexed.
export const metadata: Metadata = {
  title: appName,
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0e0e0e" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <ConsentProvider>{children}</ConsentProvider>
      </body>
    </html>
  );
}
