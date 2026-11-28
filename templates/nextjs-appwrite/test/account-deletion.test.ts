import { describe, expect, test } from "bun:test";
import { AppwriteException } from "node-appwrite";
import {
  DELETION_COMPLETE, DELETION_NOT_STARTED, DELETION_PENDING, isReservedAccountEmail,
  finishPendingDeletions, hasDeletionRecord, requestAccountDeletion, type DeletionClients,
} from "../lib/account-deletion";

const id = "Custom-ID";
const creation = "2026-01-01T00:00:00.000+00:00";
const email = "fixture@example.test";
const deletedEmail = "deleted-aabbccddeeff@deleted.invalid";
const settle = 10 * 60_000;
const mine = ['read("user:Custom-ID")', 'delete("user:Custom-ID")'];
const shared = [...mine, 'read("team:shared")'];
const failure = (code: number, type = "") => new AppwriteException("fixture failure", code, type);

function fixture() {
  const person = {
    $id: id, $createdAt: creation, status: true, email, phone: "+12025550100",
    name: "Fixture", prefs: { theme: "dark" } as Record<string, unknown>, labels: ["fixture"],
  };
  type Row = {
    $id: string; $createdAt: string; $updatedAt: string; owner?: string; $permissions: string[];
    userId?: string; userCreatedAt?: string; placeholderEmail?: string; verifiedAt?: string | null; remaining?: string | null;
  };
  const records = new Map<string, Row>();
  const items = new Map<string, Row>();
  const identities = new Set<string>();
  const sessions = new Set(["fixture-session"]);
  const targets = new Set(["original-email", "original-phone"]);
  const transactions = new Map<string, { tableId: string; rowId: string; stagedAt: string; data?: Partial<Row> }[]>();
  let now = Date.parse("2026-01-02");
  const clock = () => now;
  const advance = (ms: number) => { now += ms; };
  const stamp = () => new Date(now).toISOString();
  const flags = {
    failRecord: false, failBlock: false, loseBlockResponse: false, failPrefs: false, failUserRead: false,
    failDelete: "", shareAfterList: "", shareAfterRead: "", emailWrites: 0, emailConflicts: 0, failTarget: "",
    beforeBlock: undefined as (() => Promise<void>) | undefined,
  };
  const record = (userId = id, userCreatedAt = creation, at = creation) =>
    records.set(userId, { $id: userId, $createdAt: at, $updatedAt: at, $permissions: [], userId, userCreatedAt, placeholderEmail: deletedEmail });
  const row = (rowId: string, $permissions = mine) => ({ $id: rowId, $createdAt: creation, $updatedAt: stamp(), owner: id, $permissions });
  const where = (tableId: string) => tableId === "items" ? items : records;
  const query = (queries: string[], name: string) =>
    queries.map((query) => JSON.parse(query) as { method: string; values: string[] }).find((q) => q.method === name)?.values[0];
  const page = (values: string[], queries: string[]) => {
    const after = query(queries, "greaterThan") ?? query(queries, "cursorAfter") ?? "";
    return values.sort().filter((id) => id > after).slice(0, Number(query(queries, "limit")) || 25);
  };
  let serial = 0;
  const tables = {
    async listRows({ tableId, queries }: { tableId: string; queries: string[] }) {
      const bucket = where(tableId);
      const owner = query(queries, "equal");
      const result = page([...bucket.values()].filter((row) => !owner || row.owner === owner).map((row) => row.$id), queries)
        .map((id) => structuredClone(bucket.get(id)!));
      if (tableId === "items" && flags.shareAfterList && result.some((row) => row.$id === flags.shareAfterList)) {
        items.set(flags.shareAfterList, row(flags.shareAfterList, shared));
        flags.shareAfterList = "";
      }
      return { rows: result };
    },
    async getRow({ tableId, rowId }: { tableId: string; rowId: string }) {
      const stored = where(tableId).get(rowId);
      if (!stored) throw failure(404, "row_not_found");
      if (tableId === "items" && flags.shareAfterRead === rowId && transactions.size) {
        advance(1);
        items.set(rowId, row(rowId, shared));
        flags.shareAfterRead = "";
      }
      return structuredClone(stored);
    },
    async createRow({ rowId, data }: { rowId: string; data: Partial<Row> }) {
      if (flags.failRecord) throw failure(500);
      if (records.has(rowId)) throw failure(409, "row_already_exists");
      record(data.userId, data.userCreatedAt, stamp());
      Object.assign(records.get(rowId)!, data);
      return structuredClone(records.get(rowId)!);
    },
    async createTransaction() {
      const $id = `tx-${++serial}`;
      transactions.set($id, []);
      return { $id };
    },
    async deleteRow({ tableId, rowId, transactionId }: { tableId: string; rowId: string; transactionId: string }) {
      if (rowId === flags.failDelete) throw failure(500);
      const stored = where(tableId).get(rowId);
      if (!stored) throw failure(404, "row_not_found");
      transactions.get(transactionId)!.push({ tableId, rowId, stagedAt: stamp() });
    },
    async updateRow({ tableId, rowId, transactionId, data }: { tableId: string; rowId: string; transactionId: string; data: Partial<Row> }) {
      transactions.get(transactionId)!.push({ tableId, rowId, stagedAt: stamp(), data });
    },
    async updateTransaction({ transactionId }: { transactionId: string }) {
      const staged = transactions.get(transactionId)!;
      for (const { tableId, rowId, stagedAt, data } of staged) {
        const stored = where(tableId).get(rowId);
        if (!stored) throw failure(404, "row_not_found");
        // Appwrite checks the timestamp. Two different versions in the
        // same millisecond do not necessarily conflict.
        if (stored.$updatedAt > stagedAt) throw failure(409, "transaction_conflict");
        if (data) where(tableId).set(rowId, { ...stored, ...data, $updatedAt: stamp() });
        else where(tableId).delete(rowId);
      }
      transactions.delete(transactionId);
    },
    async deleteTransaction({ transactionId }: { transactionId: string }) { transactions.delete(transactionId); },
  };
  const users = {
    async get({ userId }: { userId: string }) {
      if (flags.failUserRead) throw failure(500);
      if (userId !== id) throw failure(404, "user_not_found");
      return structuredClone(person);
    },
    async updateStatus({ status }: { status: boolean }) {
      await flags.beforeBlock?.();
      if (flags.failBlock) throw failure(500);
      person.status = status;
      if (flags.loseBlockResponse) throw failure(500);
      return structuredClone(person);
    },
    async listSessions() { return { sessions: [...sessions] }; },
    async deleteSessions() { sessions.clear(); },
    async listIdentities({ queries }: { queries: string[] }) {
      expect(query(queries, "equal")).toBe(id);
      return { identities: page([...identities], queries).map(($id) => ({ $id })) };
    },
    async deleteIdentity({ identityId }: { identityId: string }) { identities.delete(identityId); },
    async updateEmail({ email }: { email: string }) {
      flags.emailWrites++;
      if (flags.emailConflicts > 0) {
        flags.emailConflicts--;
        throw failure(409, "user_target_already_exists");
      }
      person.email = email;
      targets.add("new-placeholder-target");
    },
    async listTargets({ queries }: { queries: string[] }) {
      return { targets: page([...targets], queries).map(($id) => ({ $id })) };
    },
    async deleteTarget({ targetId }: { targetId: string }) {
      if (flags.failTarget === targetId) throw failure(500);
      targets.delete(targetId);
    },
    async updatePhone({ number }: { number: string }) { person.phone = number; },
    async updateName({ name }: { name: string }) { person.name = name; },
    async updateLabels({ labels }: { labels: string[] }) { person.labels = labels; },
    async updatePrefs({ prefs }: { prefs: typeof person.prefs }) {
      if (flags.failPrefs) throw failure(500);
      if (!Object.keys(prefs).length) throw failure(400, "general_argument_invalid");
      person.prefs = prefs;
    },
  };
  const clients = { tables, users } as unknown as DeletionClients;
  const request = () => requestAccountDeletion(clients, { $id: id, $createdAt: creation, email }, clock);
  const finish = () => finishPendingDeletions(clients, clock);
  const deleting = () => hasDeletionRecord(clients.tables, person);
  return { person, records, items, identities, sessions, targets, flags, record, row, request, finish, advance, deleting };
}

describe("account deletion", () => {
  test("reserves the placeholder domain regardless of case", () => {
    expect(isReservedAccountEmail("random@DELETED.INVALID")).toBe(true);
    expect(isReservedAccountEmail("random@deleted.invalid.")).toBe(true);
    expect(isReservedAccountEmail("random@not-deleted.invalid")).toBe(false);
  });

  test("keeps shared rows with a forged owner and checks permissions again after listing", async () => {
    const f = fixture();
    f.items.set("a", f.row("a", shared));
    f.items.set("b", f.row("b"));
    f.items.set("c", f.row("c"));
    f.flags.shareAfterList = "b";
    expect(await f.request()).toEqual({ notice: DELETION_COMPLETE });
    expect([...f.items.keys()]).toEqual(["a", "b"]);
  });

  test("detects a share with a newer timestamp than the staged deletion", async () => {
    const f = fixture();
    f.items.set("a", f.row("a"));
    f.flags.shareAfterRead = "a";
    await f.request();
    await f.finish();
    expect(f.items.get("a")?.$permissions).toEqual(shared);
    expect(f.records.size).toBe(1);
  });

  test("the worker resumes a durable request while the original block call is delayed", async () => {
    const f = fixture();
    f.items.set("a", f.row("a"));
    let release!: () => void;
    let reached!: () => void;
    const blocking = new Promise<void>((resolve) => { reached = resolve; });
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    f.flags.beforeBlock = () => { reached(); return delayed; };
    const first = f.request();
    await blocking;
    expect(await f.deleting()).toBe(true);
    const second = await f.request();
    expect(second).toHaveProperty("error");
    f.advance(settle * 2);
    f.flags.beforeBlock = undefined;
    await f.finish();
    expect(f.records.has(id)).toBe(true);
    expect(f.items.has("a")).toBe(false);
    release();
    expect(await first).toEqual({ notice: DELETION_COMPLETE });
    expect(f.flags.emailWrites).toBe(1);
    expect(f.person.status).toBe(false);
  });

  test("a restarted job resumes a partial sweep and reaches records past the first page", async () => {
    const f = fixture();
    f.items.set("a", f.row("a"));
    f.items.set("b", f.row("b"));
    f.flags.failDelete = "b";
    expect(await f.request()).toEqual({ notice: DELETION_PENDING });
    expect([...f.items.keys()]).toEqual(["b"]);
    for (let i = 0; i < 101; i++) f.record(`A-${String(i).padStart(3, "0")}`);
    f.flags.failDelete = "";
    await f.finish();
    expect(f.items.size).toBe(0);
    expect(f.records.size).toBe(1);
    expect(f.person.email).toMatch(/^deleted-[a-f0-9]+@deleted\.invalid$/);
    f.advance(settle);
    await f.finish();
    expect(f.records.size).toBe(0);
    expect(f.person.prefs).toEqual({ runportAccountDeleted: true });
  });

  test("leaves an account blocked by an admin alone without a record or with a stale account record", async () => {
    const f = fixture();
    f.person.status = false;
    f.items.set("a", f.row("a"));
    await f.finish();
    expect(f.items.size).toBe(1);
    f.record(id, "2001-01-01");
    await f.finish();
    expect(f.items.size).toBe(1);
    expect(f.person.email).toBe(email);
    expect(f.records.size).toBe(0);
  });

  test("reasserts the block after a late password write and restarts the settle period", async () => {
    const f = fixture();
    expect(await f.request()).toEqual({ notice: DELETION_COMPLETE });
    f.person.status = true;
    f.person.email = email;
    f.sessions.add("late-session");
    f.advance(settle + 1);
    await f.finish();
    expect(f.person.status).toBe(false);
    expect(f.sessions.size).toBe(0);
    expect(f.person.email).toBe(f.records.get(id)?.placeholderEmail ?? "");
    expect(await f.deleting()).toBe(true);
    f.advance(settle);
    await f.finish();
    expect(await f.deleting()).toBe(false);
  });

  test("clears a late name and row, then requires two clean runs", async () => {
    const f = fixture();
    await f.request();
    f.advance(settle - 1);
    await f.finish();
    expect(f.records.size).toBe(1);
    f.person.name = "Late name";
    f.items.set("late", f.row("late"));
    f.advance(1);
    await f.finish();
    expect(f.person.name).toBe("");
    expect(f.items.size).toBe(0);
    expect(f.records.size).toBe(1);
    f.advance(settle);
    await f.finish();
    expect(f.records.size).toBe(0);
  });

  test("a failed verification between clean runs resets the settle period", async () => {
    const f = fixture();
    await f.request();
    f.advance(settle);
    f.flags.failUserRead = true;
    expect(await f.finish()).toEqual({ failed: 1 });
    expect(f.records.get(id)?.verifiedAt).toBeNull();
    expect(f.records.get(id)?.remaining).toBe("verification");
    f.flags.failUserRead = false;
    await f.finish();
    expect(f.records.size).toBe(1);
    f.advance(settle);
    await f.finish();
    expect(f.records.size).toBe(0);
  });

  test("persists a new random placeholder on conflict and scrubs every messaging target", async () => {
    const f = fixture();
    f.record();
    f.flags.emailConflicts = 1;
    for (let i = 0; i < 205; i++) f.targets.add(String(i));
    await f.finish();
    expect(f.flags.emailWrites).toBe(2);
    expect(f.person.email).not.toBe(deletedEmail);
    expect(f.person.email).toBe(f.records.get(id)?.placeholderEmail ?? "");
    expect(f.person.email).toMatch(/^deleted-[a-f0-9]+@deleted\.invalid$/);
    expect(f.targets.size).toBe(0);
  });

  test("records a failed target and continues other anonymisation", async () => {
    const f = fixture();
    f.flags.failTarget = "original-phone";
    expect(await f.request()).toEqual({ notice: DELETION_PENDING });
    expect(f.person.name).toBe("");
    expect(f.person.phone).toBe("");
    expect(f.targets).toEqual(new Set(["original-phone"]));
    expect(f.records.get(id)?.remaining).toBe("targets");
    expect(f.records.get(id)?.verifiedAt ?? null).toBeNull();
  });

  test("drains all identity pages and accepts an already-normalized placeholder for an uppercase ID", async () => {
    const f = fixture();
    f.person.email = deletedEmail;
    f.person.status = false;
    f.record();
    for (let i = 0; i < 205; i++) f.identities.add(String(i));
    await f.finish();
    expect(f.flags.emailWrites).toBe(0);
    expect(f.identities.size).toBe(0);
    expect(f.sessions.size).toBe(0);
    expect(f.person).toMatchObject({ email: deletedEmail, phone: "", name: "", prefs: { runportAccountDeleted: true }, labels: [] });
    expect(f.records.size).toBe(1);
  });

  test("a queuing failure leaves the account intact and a block failure stays queued", async () => {
    for (const step of ["failRecord", "failBlock"] as const) {
      const f = fixture();
      f.items.set("a", f.row("a"));
      f.flags[step] = true;
      const result = await f.request();
      if (step === "failRecord") expect(result).toEqual({ error: DELETION_NOT_STARTED });
      else expect(result).toHaveProperty("error");
      expect(f.person.status).toBe(true);
      expect(f.items.size).toBe(1);
      expect(f.person.email).toBe(email);
      expect(f.records.size).toBe(step === "failRecord" ? 0 : 1);
    }
  });

  test("a lost block response and failed preferences cleanup report the account as closed and pending", async () => {
    const f = fixture();
    f.flags.loseBlockResponse = true;
    f.flags.failPrefs = true;
    expect(await f.request()).toEqual({ notice: DELETION_PENDING });
    expect(f.person.status).toBe(false);
    expect(f.records.size).toBe(1);
    f.flags.failPrefs = false;
    await f.finish();
    expect(f.person.prefs).toEqual({ runportAccountDeleted: true });
    expect(f.records.size).toBe(1);
  });
});
