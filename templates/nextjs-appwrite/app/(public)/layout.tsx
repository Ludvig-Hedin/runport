import type { Metadata } from "next";
import { connection } from "next/server";
import { indexingAllowed } from "@/lib/config";

export async function generateMetadata(): Promise<Metadata> {
  await connection();
  const index = indexingAllowed();
  return { robots: { index, follow: index } };
}

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return children;
}
