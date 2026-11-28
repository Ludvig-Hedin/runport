"use client";

import { useCallback, useEffect, useId, useState } from "react";
import type { Inventory } from "@/lib/server/app-ops";
import type { AppRow } from "@/lib/server/overview";
import { bytes, plural } from "./format";

type Step = "stop" | "backup" | "check" | "data" | "hosting" | "done";
const STEPS: { id: Exclude<Step, "done">; label: string }[] = [
  { id: "stop", label: "Stop the app and pause all changes" },
  { id: "backup", label: "Back up users, data and files" },
  { id: "check", label: "Check the backup" },
  { id: "data", label: "Delete users, data and files" },
  { id: "hosting", label: "Remove the address and hosting" },
];

type Run =
  | { state: "idle" }
  | { state: "running"; step: Step }
  | { state: "failed"; step: Step; error: string; deleted: boolean }
  | { state: "done"; backup: string };

type Props = {
  row: AppRow;
  /** False once the address no longer asks for the sheet, for example after the back gesture. */
  visible: boolean;
  /** Asks the parent to close (it drops ?delete= from the address). */
  onRequestClose: () => void;
  /** Called after the closing glide, to unmount. */
  onClosed: () => void;
  onDeleted: (row: AppRow, backup: string) => void;
};

export function DeleteSheet({ row, visible, onRequestClose, onClosed, onDeleted }: Props) {
  const [open, setOpen] = useState(false);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [countError, setCountError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [run, setRun] = useState<Run>({ state: "idle" });
  const titleId = useId();
  const running = run.state === "running";

  const loadCounts = useCallback(async () => {
    setCountError(null);
    setInventory(null);
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(row.slug)}/inventory`, { cache: "no-store" });
      const body = (await res.json()) as Inventory & { error?: string };
      if (!res.ok) throw new Error(body.error ?? "No answer.");
      setInventory(body);
    } catch {
      setCountError("Couldn’t count what’s in this app.");
    }
  }, [row.slug]);

  useEffect(() => {
    void loadCounts();
  }, [loadCounts]);

  // Glide in on the next frame, so the closed state is painted first; glide
  // out when the address drops the sheet, then unmount.
  useEffect(() => {
    if (visible || running) {
      const frame = requestAnimationFrame(() => setOpen(true));
      return () => cancelAnimationFrame(frame);
    }
    setOpen(false);
    const t = setTimeout(onClosed, 380);
    return () => clearTimeout(t);
  }, [visible, running, onClosed]);

  const close = useCallback(() => {
    if (!running) onRequestClose();
  }, [running, onRequestClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [close]);

  const matches = typed.trim().toLowerCase() === row.name.trim().toLowerCase();
  const canDelete = matches && !!inventory && !inventory.blocked && run.state !== "running" && run.state !== "done";

  async function start() {
    if (!canDelete) return;
    setRun({ state: "running", step: "stop" });
    let step: Step = "stop";
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(row.slug)}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: typed }),
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw Object.assign(new Error(body.error ?? "The delete did not start."), { deleted: false });
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines.filter(Boolean)) {
          const event = JSON.parse(line) as { step: Step | "error"; error?: string; deleted?: boolean; backup?: string; failedAt?: Step };
          if (event.step === "error") throw Object.assign(new Error(event.error), { deleted: !!event.deleted });
          if (event.step === "done") {
            setRun({ state: "done", backup: event.backup ?? "" });
            setTimeout(() => onDeleted(row, event.backup ?? ""), 1800);
            return;
          }
          step = event.step;
          setRun({ state: "running", step });
        }
      }
      throw Object.assign(new Error("The connection ended before the delete finished. Reload to see where it got to."), { deleted: step === "data" || step === "hosting" });
    } catch (error) {
      const e = error as Error & { deleted?: boolean };
      setRun({ state: "failed", step, error: e.message, deleted: !!e.deleted });
    }
  }

  const stepState = (id: Exclude<Step, "done">): "todo" | "active" | "done" | "failed" => {
    if (run.state === "done") return "done";
    if (run.state === "idle") return "todo";
    const order = STEPS.findIndex((s) => s.id === id);
    const at = STEPS.findIndex((s) => s.id === run.step);
    if (order < at) return "done";
    if (order > at) return "todo";
    return run.state === "failed" ? "failed" : "active";
  };

  const host = row.url ? new URL(row.url).host : null;

  return (
    <div className="db-sheet-root" data-open={open || undefined}>
      <div className="db-sheet-backdrop" onClick={() => close()} aria-hidden="true" />
      <div className="db-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="db-sheet-top">
          <h2 id={titleId} className="db-sheet-title">
            Delete {row.name}?
          </h2>
          <button type="button" className="db-icon-btn" onClick={() => close()} disabled={running} aria-label="Close">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

        <div className="db-sheet-body">
          <section>
            <h3 className="db-sheet-h">This disappears</h3>
            {countError ? (
              <div className="db-block-error" role="alert">
                <p>{countError}</p>
                <button type="button" className="db-btn db-btn-sm db-btn-secondary" onClick={loadCounts}>
                  Try again
                </button>
              </div>
            ) : (
              <ul className="db-list db-list-gone">
                <li>{inventory ? plural(inventory.users, "user and their sign-in", "users and their sign-ins") : <span className="db-skel db-skel-inline" />}</li>
                <li>
                  {inventory ? (
                    `${plural(inventory.rows, "row", "rows")} of data in ${plural(inventory.tables, "table", "tables")}`
                  ) : (
                    <span className="db-skel db-skel-inline" />
                  )}
                </li>
                <li>
                  {inventory ? (
                    `${plural(inventory.files, "file", "files")}${inventory.files ? ` (${bytes(inventory.bytes)})` : ""}`
                  ) : (
                    <span className="db-skel db-skel-inline" />
                  )}
                </li>
                <li>{host ? `The address ${host} and its hosting` : "Its hosting"}</li>
              </ul>
            )}
          </section>

          <section>
            <h3 className="db-sheet-h">This is kept</h3>
            <ul className="db-list db-list-kept">
              <li>A full backup of the above, made right before deleting</li>
              <li>
                The code
                {row.git ? (
                  <>
                    {" "}
                    on{" "}
                    <a href={row.git.url} target="_blank" rel="noreferrer" className="db-link">
                      {row.git.host === "runport" ? "Runport Git" : row.git.host === "github" ? "GitHub" : "its repo"}
                    </a>
                  </>
                ) : null}{" "}
                and the copy on your Mac
              </li>
              <li>Visitor stats</li>
            </ul>
          </section>

          {inventory?.blocked ? (
            <p className="db-row-error" role="alert">
              This app can’t be deleted here yet. {inventory.blocked} Nothing was changed.
            </p>
          ) : run.state === "idle" ? (
            <div className="db-field">
              <label htmlFor="confirm-name" className="db-label">
                Type <strong>{row.name}</strong> to confirm
              </label>
              <input
                id="confirm-name"
                className="db-input"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && start()}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
          ) : (
            <ol className="db-steps" aria-live="polite">
              {STEPS.map((s) => {
                const state = stepState(s.id);
                return (
                  <li key={s.id} data-state={state}>
                    <span className="db-step-mark" aria-hidden="true">
                      {state === "active" ? <span className="db-spinner" /> : state === "done" ? "✓" : state === "failed" ? "!" : ""}
                    </span>
                    {s.label}
                  </li>
                );
              })}
            </ol>
          )}

          {run.state === "failed" ? (
            <p className="db-row-error" role="alert">
              {run.deleted
                ? `It stopped partway: ${run.error} The backup is saved. Try again to finish.`
                : `Nothing was deleted, because the backup did not work. ${run.error}`}
            </p>
          ) : null}
          {run.state === "done" ? <p className="db-done">Deleted. The backup is saved as {run.backup}.</p> : null}
        </div>

        <div className="db-sheet-actions">
          <button type="button" className="db-btn db-btn-secondary" onClick={() => close()} disabled={running}>
            Cancel
          </button>
          <button
            type="button"
            className="db-btn db-btn-danger"
            disabled={!canDelete && run.state !== "failed"}
            onClick={() => {
              if (run.state === "failed") setRun({ state: "idle" });
              else void start();
            }}
          >
            {running ? <span className="db-spinner" aria-hidden="true" /> : null}
            {running ? "Deleting…" : run.state === "failed" ? "Try again" : `Delete ${row.name}`}
          </button>
        </div>
      </div>
    </div>
  );
}
