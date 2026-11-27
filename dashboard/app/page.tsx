import { connection } from "next/server";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { UserButton } from "@/components/auth";
import { AppList, AppListSkeleton } from "@/components/dashboard/app-list";
import { BackupFact, CostFact, FactSkeleton, HealthFact } from "@/components/dashboard/facts";
import { access } from "@/lib/owner";

// Runport's start page: every app with its status, visitors and cost, plus
// the platform's own cost, backup and health. Only the owner gets here.

export default async function Overview() {
  await connection();
  const who = await access();
  if (who.state === "signed-out") redirect("/login");
  if (who.state === "no-access") redirect("/no-access");

  return (
    <div className="db-page">
      <header className="db-nav">
        <a href="/" className="db-brand">
          <img src="/mark.svg" alt="" width={28} height={28} />
          <span>Runport</span>
        </a>
        <UserButton />
      </header>
      <main className="db-main">
        <h1 className="db-h1">Your apps</h1>
        <div className="db-facts">
          <Suspense fallback={<FactSkeleton label="Cost this month" />}>
            <CostFact />
          </Suspense>
          <Suspense fallback={<FactSkeleton label="Last backup" />}>
            <BackupFact />
          </Suspense>
          <Suspense fallback={<FactSkeleton label="Platform" />}>
            <HealthFact />
          </Suspense>
        </div>
        <Suspense fallback={<AppListSkeleton />}>
          <AppList />
        </Suspense>
      </main>
    </div>
  );
}
