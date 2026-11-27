import type { Deliver, Envelope } from "./deliver";
import type { Kind, Limits } from "./limits";

export class MailBudgetExceeded extends Error {}
export type MailLog = (entry: Record<string, unknown>) => void;
export const jsonLog: MailLog = (entry) => console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));

export async function deliverWithinBudget(
  limits: Pick<Limits, "reserve" | "release">,
  deliver: Deliver,
  log: MailLog,
  app: string,
  kind: Kind,
  envelope: Envelope,
  raw: Buffer,
): Promise<number> {
  const recipients = envelope.to.length;
  const now = new Date();
  const entry = { app, kind, recipients, bytes: raw.length };
  const reservation = limits.reserve(app, kind, recipients, now);
  if (!reservation.ok) {
    log({ ...entry, result: "refused", reason: reservation.reason });
    throw new MailBudgetExceeded(reservation.reason);
  }
  let delivered: number;
  try {
    delivered = await deliver(envelope, raw);
  } catch (error) {
    limits.release(app, kind, recipients, now);
    log({ ...entry, result: "failed", reason: (error as Error).message });
    throw error;
  }
  if (delivered < recipients) limits.release(app, kind, recipients - delivered, now);
  log({ ...entry, delivered, result: delivered < recipients ? "partly sent" : "sent" });
  return delivered;
}
