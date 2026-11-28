import "server-only";
import { platformHealth } from "@/lib/server/health";
import { lastBackup, PLAN_MINIMUM_USD, runportCost } from "@/lib/server/railway";
import { ago, exactTime, money, shortDate } from "./format";
import { BlockError } from "./retry";

/** Logs why a block failed. Messages come from our own code and APIs, never secrets. */
export function logFailure(block: string, error: unknown): void {
  console.error(`[dashboard] ${block}: ${error instanceof Error ? error.message : String(error)}`);
}

// The three facts at the top: cost, last backup and platform health. Each is
// its own async component, so one slow or failing source never holds up the rest.

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="db-fact" aria-label={label}>
      <h2 className="db-fact-label">{label}</h2>
      {children}
    </section>
  );
}

export function FactSkeleton({ label }: { label: string }) {
  return (
    <Fact label={label}>
      <div className="db-skel db-skel-value" />
      <div className="db-skel db-skel-line" />
      <div className="db-skel db-skel-line db-skel-short" />
    </Fact>
  );
}

export async function CostFact() {
  try {
    const { total, period } = await runportCost();
    const share = Math.min(1, total / PLAN_MINIMUM_USD);
    return (
      <Fact label="Cost this month">
        <p className="db-fact-value">≈ {money(total)}</p>
        <div className="db-meter" role="img" aria-label={`${Math.round(share * 100)}% of the $${PLAN_MINIMUM_USD} plan minimum`}>
          <span style={{ width: `${share * 100}%` }} />
        </div>
        <p className="db-fact-sub">
          {total < PLAN_MINIMUM_USD ? `of the $${PLAN_MINIMUM_USD} plan minimum` : `over the $${PLAN_MINIMUM_USD} plan minimum`}
        </p>
        <p className="db-fact-note">
          Whole Railway account {money(period.accountTotal)} · {shortDate(period.start)} to {shortDate(period.end)}
        </p>
      </Fact>
    );
  } catch (error) {
    logFailure("cost", error);
    return (
      <Fact label="Cost this month">
        <BlockError what="the cost" />
      </Fact>
    );
  }
}

export async function BackupFact() {
  try {
    const last = await lastBackup();
    if (!last) {
      return (
        <Fact label="Last backup">
          <p className="db-fact-value">None yet</p>
          <p className="db-fact-sub">The nightly backup runs at 02:00.</p>
        </Fact>
      );
    }
    const stale = Date.now() - Date.parse(last.at) > 30 * 3_600_000;
    const good = last.ok && !stale;
    return (
      <Fact label="Last backup">
        <p className="db-fact-value" title={exactTime(last.at)}>{ago(last.at)}</p>
        <p className="db-fact-sub">
          <span className={`db-pill ${good ? "db-pill-yes" : "db-pill-no"}`}>{last.ok ? (stale ? "Too old" : "Succeeded") : "Failed"}</span>
          <span>{exactTime(last.at)}</span>
        </p>
        <p className="db-fact-note">
          {good ? "Every night, kept 14 days" : last.ok ? "No backup in the last day. The alert email says why." : "The alert email says why. It runs again tonight."}
        </p>
      </Fact>
    );
  } catch (error) {
    logFailure("backup", error);
    return (
      <Fact label="Last backup">
        <BlockError what="the backup status" />
      </Fact>
    );
  }
}

const WORD = { ok: "Working", down: "Down", unknown: "Unknown" } as const;

export async function HealthFact() {
  try {
    const parts = await platformHealth();
    const problems = parts.filter((p) => p.state === "down").length;
    const unknown = parts.filter((p) => p.state === "unknown").length;
    return (
      <Fact label="Platform">
        <p className="db-fact-value">{problems === 1 ? "1 problem" : problems > 1 ? `${problems} problems` : unknown ? "Partly unknown" : "All working"}</p>
        <ul className="db-health">
          {parts.map((p) => (
            <li key={p.name} title={p.detail}>
              <span className={`db-dot db-dot-${p.state}`} aria-hidden="true" />
              <span className="db-health-name">{p.name}</span>
              <span className="db-health-state">{WORD[p.state]}</span>
            </li>
          ))}
        </ul>
      </Fact>
    );
  } catch (error) {
    logFailure("health", error);
    return (
      <Fact label="Platform">
        <BlockError what="platform health" />
      </Fact>
    );
  }
}
