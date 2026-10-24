import { Database } from "bun:sqlite";

// Daily sending caps. Counts recipients, not messages, because that is what
// costs money and what a spammer would inflate. Days follow Stockholm time so
// the cap resets at local midnight.

export type Caps = { total: number; perApp: number };

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
      "CREATE TABLE IF NOT EXISTS sent (day TEXT NOT NULL, app TEXT NOT NULL, recipients INTEGER NOT NULL, PRIMARY KEY (day, app))",
    );
  }

  /** Counts the recipients against both caps, or refuses without counting anything. */
  reserve(app: string, recipients: number, now = new Date()): Reservation {
    const day = stockholmDay(now);
    return this.db.transaction((): Reservation => {
      const total = this.db.query("SELECT COALESCE(SUM(recipients), 0) AS n FROM sent WHERE day = ?").get(day) as { n: number };
      const mine = this.db.query("SELECT recipients AS n FROM sent WHERE day = ? AND app = ?").get(day, app) as { n: number } | null;
      if (total.n + recipients > this.caps.total) {
        return { ok: false, reason: `daily limit of ${this.caps.total} emails for all apps reached` };
      }
      if ((mine?.n ?? 0) + recipients > this.caps.perApp) {
        return { ok: false, reason: `daily limit of ${this.caps.perApp} emails for ${app} reached` };
      }
      this.db
        .query("INSERT INTO sent (day, app, recipients) VALUES (?, ?, ?) ON CONFLICT (day, app) DO UPDATE SET recipients = recipients + excluded.recipients")
        .run(day, app, recipients);
      return { ok: true };
    })();
  }

  /** Gives back a reservation when delivery failed, so failures do not use up the cap. */
  release(app: string, recipients: number, now = new Date()): void {
    this.db
      .query("UPDATE sent SET recipients = MAX(recipients - ?, 0) WHERE day = ? AND app = ?")
      .run(recipients, stockholmDay(now), app);
  }

  today(now = new Date()): { day: string; total: number; caps: Caps; apps: Record<string, number> } {
    const day = stockholmDay(now);
    const rows = this.db.query("SELECT app, recipients FROM sent WHERE day = ?").all(day) as { app: string; recipients: number }[];
    const apps = Object.fromEntries(rows.map((r) => [r.app, r.recipients]));
    return { day, total: rows.reduce((sum, r) => sum + r.recipients, 0), caps: this.caps, apps };
  }
}
