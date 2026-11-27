import { Database } from "bun:sqlite";

// Daily sending caps. Counts recipients, not messages, because that is what
// costs money and what a spammer would inflate. Days follow Stockholm time so
// the cap resets at local midnight.
//
// Two kinds of mail: "mail" (login codes, receipts, anything one person
// triggers) and "news" (newsletters and other bulk sends). News has its own
// per-app cap and may only fill part of the total, so a big send can never
// use up the room login codes need.

export type Kind = "mail" | "news" | "form";
export type Caps = {
  total: number;
  perApp: number;
  perAppNews: number;
  newsShare: number;
  perAppForm: number;
  perHourForm: number;
  formShare: number;
};

export type Reservation = { ok: true } | { ok: false; reason: string };

export const stockholmDay = (now = new Date()) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(now);

// UTC hours are unambiguous when Stockholm changes clocks. Hour keys share
// the same table but are outside the namespace used by daily totals.
const hourBucket = (now: Date) => `hour:${now.toISOString().slice(0, 13)}`;

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
      if (kind !== "mail") {
        const automation = this.db.query("SELECT COALESCE(SUM(recipients), 0) AS n FROM sent_by_kind WHERE day = ? AND kind != 'mail'").get(day) as { n: number };
        const automationCap = Math.floor(this.caps.total * Math.min(this.caps.newsShare, 0.7));
        if (automation.n + recipients > automationCap) {
          return { ok: false, reason: "daily automation budget reached; capacity reserved for account mail" };
        }
      }
      const appCap = { mail: this.caps.perApp, news: this.caps.perAppNews, form: this.caps.perAppForm }[kind];
      if ((mine?.n ?? 0) + recipients > appCap) {
        const label = { mail: "", news: "newsletter ", form: "form " }[kind];
        return { ok: false, reason: `daily limit of ${appCap} ${label}emails for ${app} reached` };
      }
      if (kind === "form") {
        const daily = this.db.query("SELECT COALESCE(SUM(recipients), 0) AS n FROM sent_by_kind WHERE day = ? AND kind = 'form'").get(day) as { n: number };
        const cap = Math.floor(this.caps.total * this.caps.formShare);
        if (daily.n + recipients > cap) return { ok: false, reason: `daily limit of ${cap} form emails for all apps reached` };
        const hour = hourBucket(now);
        const hourly = this.db.query("SELECT recipients AS n FROM sent_by_kind WHERE day = ? AND app = ? AND kind = 'form'").get(hour, app) as { n: number } | null;
        if ((hourly?.n ?? 0) + recipients > this.caps.perHourForm) {
          return { ok: false, reason: `hourly limit of ${this.caps.perHourForm} form emails for ${app} reached` };
        }
        this.increment(hour, app, kind, recipients);
        this.db.query("DELETE FROM sent_by_kind WHERE day >= 'hour:' AND day < ? AND kind = 'form'")
          .run(hourBucket(new Date(now.getTime() - 24 * 60 * 60 * 1000)));
      }
      this.increment(day, app, kind, recipients);
      return { ok: true };
    }).immediate();
  }

  private increment(bucket: string, app: string, kind: Kind, recipients: number): void {
    this.db.query(
      "INSERT INTO sent_by_kind (day, app, kind, recipients) VALUES (?, ?, ?, ?) ON CONFLICT (day, app, kind) DO UPDATE SET recipients = recipients + excluded.recipients",
    ).run(bucket, app, kind, recipients);
  }

  /** Gives back a reservation when delivery failed, so failures do not use up the cap. */
  release(app: string, kind: Kind, recipients: number, now = new Date()): void {
    const update = this.db.query("UPDATE sent_by_kind SET recipients = MAX(recipients - ?, 0) WHERE day = ? AND app = ? AND kind = ?");
    this.db.transaction(() => {
      update.run(recipients, stockholmDay(now), app, kind);
      if (kind === "form") update.run(recipients, hourBucket(now), app, kind);
    })();
  }

  today(now = new Date()): { day: string; total: number; caps: Caps; apps: Record<string, { mail: number; news: number; form?: number }> } {
    const day = stockholmDay(now);
    const rows = this.db.query("SELECT app, kind, recipients FROM sent_by_kind WHERE day = ?").all(day) as { app: string; kind: Kind; recipients: number }[];
    const apps: Record<string, { mail: number; news: number; form?: number }> = {};
    for (const r of rows) (apps[r.app] ??= { mail: 0, news: 0 })[r.kind] = r.recipients;
    return { day, total: rows.reduce((sum, r) => sum + r.recipients, 0), caps: this.caps, apps };
  }
}
