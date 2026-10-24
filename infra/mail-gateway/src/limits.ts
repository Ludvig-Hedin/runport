import { Database } from "bun:sqlite";

// Daily sending caps. Counts recipients, not messages, because that is what
// costs money and what a spammer would inflate. Days follow Stockholm time so
// the cap resets at local midnight.
//
// Two kinds of mail: "mail" (login codes, receipts, anything one person
// triggers) and "news" (newsletters and other bulk sends). News has its own
// per-app cap and may only fill part of the total, so a big send can never
// use up the room login codes need.

export type Kind = "mail" | "news";
export type Caps = { total: number; perApp: number; perAppNews: number; newsShare: number };

export type Reservation = { ok: true } | { ok: false; reason: string };

export const stockholmDay = (now = new Date()) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(now);

export class Limits {
  private readonly db: Database;

  constructor(
    path: string,
    private readonly caps: Caps,
  ) {
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(
      "CREATE TABLE IF NOT EXISTS sent_by_kind (day TEXT NOT NULL, app TEXT NOT NULL, kind TEXT NOT NULL, recipients INTEGER NOT NULL, PRIMARY KEY (day, app, kind))",
    );
  }

  /** Counts the recipients against every cap that applies, or refuses without counting anything. */
  reserve(app: string, kind: Kind, recipients: number, now = new Date()): Reservation {
    const day = stockholmDay(now);
    return this.db.transaction((): Reservation => {
      const all = this.db.query("SELECT COALESCE(SUM(recipients), 0) AS n FROM sent_by_kind WHERE day = ?").get(day) as { n: number };
      const mine = this.db.query("SELECT recipients AS n FROM sent_by_kind WHERE day = ? AND app = ? AND kind = ?").get(day, app, kind) as
        | { n: number }
        | null;
      const totalCap = kind === "news" ? Math.floor(this.caps.total * this.caps.newsShare) : this.caps.total;
      if (all.n + recipients > totalCap) {
        return {
          ok: false,
          reason: kind === "news" ? `newsletters may use at most ${totalCap} of today's ${this.caps.total} emails` : `daily limit of ${totalCap} emails for all apps reached`,
        };
      }
      const appCap = kind === "news" ? this.caps.perAppNews : this.caps.perApp;
      if ((mine?.n ?? 0) + recipients > appCap) {
        return { ok: false, reason: `daily limit of ${appCap} ${kind === "news" ? "newsletter " : ""}emails for ${app} reached` };
      }
      this.db
        .query(
          "INSERT INTO sent_by_kind (day, app, kind, recipients) VALUES (?, ?, ?, ?) ON CONFLICT (day, app, kind) DO UPDATE SET recipients = recipients + excluded.recipients",
        )
        .run(day, app, kind, recipients);
      return { ok: true };
    })();
  }

  /** Gives back a reservation when delivery failed, so failures do not use up the cap. */
  release(app: string, kind: Kind, recipients: number, now = new Date()): void {
    this.db
      .query("UPDATE sent_by_kind SET recipients = MAX(recipients - ?, 0) WHERE day = ? AND app = ? AND kind = ?")
      .run(recipients, stockholmDay(now), app, kind);
  }

  today(now = new Date()): { day: string; total: number; caps: Caps; apps: Record<string, Record<Kind, number>> } {
    const day = stockholmDay(now);
    const rows = this.db.query("SELECT app, kind, recipients FROM sent_by_kind WHERE day = ?").all(day) as { app: string; kind: Kind; recipients: number }[];
    const apps: Record<string, Record<Kind, number>> = {};
    for (const r of rows) (apps[r.app] ??= { mail: 0, news: 0 })[r.kind] = r.recipients;
    return { day, total: rows.reduce((sum, r) => sum + r.recipients, 0), caps: this.caps, apps };
  }
}
