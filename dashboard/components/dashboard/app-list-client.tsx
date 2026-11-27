"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AppRow } from "@/lib/server/overview";
import type { AppStatus } from "@/lib/server/railway";
import { DeleteSheet } from "./delete-sheet";
import { ago, exactTime, money } from "./format";
import { Toast, useToast } from "./toast";

const STATUS: Record<AppStatus, { label: string; tone: string; hint?: string }> = {
  live: { label: "Live", tone: "yes" },
  sleeping: { label: "Sleeping", tone: "idle", hint: "Wakes on the next visit" },
  down: { label: "Down", tone: "no", hint: "The last start failed" },
  deploying: { label: "Deploying", tone: "maybe" },
  paused: { label: "Paused", tone: "idle", hint: "Visitors can’t reach it" },
  unknown: { label: "Unknown", tone: "idle" },
};

type Busy = { slug: string; action: "pause" | "resume" } | null;

export function AppListClient({ initialRows, now }: { initialRows: AppRow[]; now: number }) {
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [busy, setBusy] = useState<Busy>(null);
  const [rowError, setRowError] = useState<{ slug: string; message: string } | null>(null);
  const [deleting, setDeleting] = useState<AppRow | null>(null);
  const toast = useToast();
  const polls = useRef(0);

  // Fresh server data replaces the local copy, for example after Try again.
  useEffect(() => setRows(initialRows), [initialRows]);

  // While an app is deploying, check again every 8 seconds for up to 3 minutes.
  const deployingCount = rows.filter((r) => r.status === "deploying").length;
  useEffect(() => {
    if (!deployingCount || polls.current > 22) return;
    const t = setTimeout(() => {
      polls.current += 1;
      router.refresh();
    }, 8000);
    return () => clearTimeout(t);
  }, [deployingCount, rows, router]);

  const setStatus = (slug: string, status: AppStatus) => setRows((all) => all.map((r) => (r.slug === slug ? { ...r, status } : r)));

  async function act(row: AppRow, action: "pause" | "resume") {
    setBusy({ slug: row.slug, action });
    setRowError(null);
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(row.slug)}/${action}`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Railway did not answer.");
      setStatus(row.slug, action === "pause" ? "paused" : "deploying");
      polls.current = 0;
      toast.show(action === "pause" ? `${row.name} is paused.` : `${row.name} is starting.`);
    } catch (error) {
      setRowError({ slug: row.slug, message: `Couldn’t ${action} ${row.name}. ${(error as Error).message}` });
    } finally {
      setBusy(null);
    }
  }

  const onDeleted = useCallback(
    (row: AppRow, backup: string) => {
      setRows((all) => all.filter((r) => r.slug !== row.slug));
      toast.show(`${row.name} is deleted. Backup: ${backup}`, 6000);
      router.refresh();
    },
    [router, toast],
  );

  if (rows.length === 0) {
    return (
      <div className="db-empty">
        <p className="db-empty-title">No apps online yet</p>
        <p className="db-empty-text">Ask your agent to create an app with Runport and put it online. It shows up here.</p>
      </div>
    );
  }

  return (
    <>
      <ul className="db-apps">
        {rows.map((row) => {
          const status = STATUS[row.status];
          const mine = busy?.slug === row.slug;
          const error = rowError?.slug === row.slug ? rowError.message : null;
          const host = row.url ? new URL(row.url).host : null;
          return (
            <li key={row.slug} className="db-app">
              <div className="db-app-head">
                <div className="db-app-title">
                  <h3 className="db-app-name">{row.name}</h3>
                  {row.url && host ? (
                    <a className="db-app-url" href={row.url} target="_blank" rel="noreferrer">
                      {host}
                    </a>
                  ) : (
                    <span className="db-app-url db-muted">No address</span>
                  )}
                </div>
                <div className="db-app-status">
                  <span className={`db-pill db-pill-${status.tone}`}>{status.label}</span>
                  {status.hint ? <span className="db-app-hint">{status.hint}</span> : null}
                </div>
              </div>

              <dl className="db-app-stats">
                <div>
                  <dt>Visitors, 7 days</dt>
                  <dd>
                    {row.visitors.state === "ok" ? (
                      row.visitors.visitors.toLocaleString("en-GB")
                    ) : row.visitors.state === "not-set-up" ? (
                      <span className="db-muted">Not set up</span>
                    ) : (
                      <span className="db-muted" title="Couldn’t load visitors">—</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Cost this month</dt>
                  <dd>{row.costUsd === null ? <span className="db-muted" title="Couldn’t load cost">—</span> : `≈ ${money(row.costUsd)}`}</dd>
                </div>
                <div>
                  <dt>Last deploy</dt>
                  <dd title={row.lastDeployAt ? exactTime(row.lastDeployAt) : undefined}>
                    {row.lastDeployAt ? ago(row.lastDeployAt, now) : <span className="db-muted">Never</span>}
                  </dd>
                </div>
                <div>
                  <dt>Code</dt>
                  <dd>
                    {row.git ? (
                      <a href={row.git.url} target="_blank" rel="noreferrer" className="db-link">
                        {row.git.host === "runport" ? "Runport Git" : row.git.host === "github" ? "GitHub" : "Repo"}
                      </a>
                    ) : (
                      <span className="db-muted">No repo</span>
                    )}
                  </dd>
                </div>
              </dl>

              {error ? (
                <p className="db-row-error" role="alert">
                  {error}
                </p>
              ) : null}

              <div className="db-app-actions">
                {row.url ? (
                  <a className="db-btn db-btn-sm db-btn-primary" href={row.url} target="_blank" rel="noreferrer">
                    Open
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M7 17 17 7M9 7h8v8" />
                    </svg>
                  </a>
                ) : null}
                {row.status === "paused" ? (
                  <button type="button" className="db-btn db-btn-sm db-btn-secondary" disabled={!!busy} aria-busy={mine || undefined} onClick={() => act(row, "resume")}>
                    {mine ? <span className="db-spinner" aria-hidden="true" /> : null}
                    {mine ? "Resuming…" : "Resume"}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="db-btn db-btn-sm db-btn-secondary"
                    disabled={!!busy || row.status === "deploying"}
                    aria-busy={mine || undefined}
                    onClick={() => act(row, "pause")}
                  >
                    {mine ? <span className="db-spinner" aria-hidden="true" /> : null}
                    {mine ? "Pausing…" : "Pause"}
                  </button>
                )}
                <button type="button" className="db-btn db-btn-sm db-btn-ghost-danger" disabled={!!busy} onClick={() => setDeleting(row)}>
                  Delete
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {deleting ? <DeleteSheet row={deleting} onClose={() => setDeleting(null)} onDeleted={onDeleted} /> : null}
      <Toast state={toast} />
    </>
  );
}
