import { describe, expect, test } from "bun:test";
import { AppwriteException } from "node-appwrite";
import {
  DELETION_COMPLETE, DELETION_NOT_STARTED, DELETION_PENDING,
  finishPendingDeletions, requestAccountDeletion, type DeletionClients,
} from "../lib/account-deletion";

const id = "Custom-ID";
const creation = "2026-01-01T00:00:00.000+00:00";
const email = "fixture@example.test";
const deletedEmail = "deleted-custom-id@deleted.invalid";
const mine = ['read("user:Custom-ID")', 'delete("user:Custom-ID")'];
const shared = [...mine, 'read("team:shared")'];
const failure = (code: number, type = "") => new AppwriteException("fixture failure", code, type);

function fixture() {
  const person = {
    $id: id, $createdAt: creation, status: true, email, phone: "+12025550100",
    name: "Fixture", prefs: { theme: "dark" } as Record<string, unknown>, labels: ["fixture"],
  };
  type Row = { $id: string; $createdAt: string; owner?: string; $permissions: string[]; userId?: string; userCreatedAt?: string };
  const records = new Map<string, Row>();
  const items = new Map<string, Row>();
  const identities = new Set<string>();
  const sessions = new Set(["fixture-session"]);
  const transactions = new Map<string, { tableId: string; row: Row | undefined }[]>();
  const flags = {
    failRecord: false, failBlock: false, loseBlockResponse: false, failPrefs: false,
    failDelete: "", shareAfterList: "", shareAfterRead: "", emailWrites: 0,
    beforeBlock: undefined as (() => Promise<void>) | undefined,
  };
  const record = (userId = id, userCreatedAt = creation, at = creation) =>
    records.set(userId, { $id: userId, $createdAt: at, $permissions: [], userId, userCreatedAt });
  const row = (rowId: string, $permissions = mine) => ({ $id: rowId, $createdAt: creation, owner: id, $permissions });
  const where = (tableId: string) => tableId === "items" ? items : records;
  const query = (queries: string[], name: string) =>
    queries.map((query) => JSON.parse(query) as { method: string; values: string[] }).find((q) => q.method === name)?.values[0];
  const page = (values: string[], queries: string[]) => {
    const after = query(queries, "greaterThan") ?? "";
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
        items.set(rowId, row(rowId, shared));
        flags.shareAfterRead = "";
      }
      return structuredClone(stored);
    },
    async createRow({ rowId, data }: { rowId: string; data: { userId: string; userCreatedAt: string } }) {
      if (flags.failRecord) throw failure(500);
      if (records.has(rowId)) throw failure(409, "row_already_exists");
      record(data.userId, data.userCreatedAt, new Date().toISOString());
      return records.get(rowId)!;
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
      transactions.get(transactionId)!.push({ tableId, row: stored });
    },
    async updateTransaction({ transactionId }: { transactionId: string }) {
      const staged = transactions.get(transactionId)!;
      if (staged.some(({ tableId, row }) => where(tableId).get(row!.$id) !== row)) throw failure(409, "transaction_conflict");
      for (const { tableId, row } of staged) where(tableId).delete(row!.$id);
      transactions.delete(transactionId);
    },
    async deleteTransaction({ transactionId }: { transactionId: string }) { transactions.delete(transactionId); },
  };
  const users = {
    async get({ userId }: { userId: string }) {
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
    async updateEmail({ email }: { email: string }) { flags.emailWrites++; person.email = email; },
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
  const request = () => requestAccountDeletion(clients, { $id: id, $createdAt: creation, email });
  const finish = () => finishPendingDeletions(clients);
  return { person, records, items, identities, sessions, flags, record, row, request, finish };
}

describe("account deletion", () => {
  test("keeps shared rows with a forged owner and checks permissions again after listing", async () => {
    const f = fixture();
    f.items.set("a", f.row("a", shared));
    f.items.set("b", f.row("b"));
    f.items.set("c", f.row("c"));
    f.flags.shareAfterList = "b";
    expect(await f.request()).toEqual({ notice: DELETION_COMPLETE });
    expect([...f.items.keys()]).toEqual(["a", "b"]);
  });

  test("preserves a row shared after its final read and before the transaction commits", async () => {
    const f = fixture();
    f.items.set("a", f.row("a"));
    f.flags.shareAfterRead = "a";
    await f.request();
    await f.finish();
    expect(f.items.get("a")?.$permissions).toEqual(shared);
    expect(f.records.size).toBe(0);
  });

  test("keeps the intent while two tabs and the maintenance job race to close the account", async () => {
    const f = fixture();
    f.items.set("a", f.row("a"));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    f.flags.beforeBlock = () => blocked;
    const first = f.request();
    await Promise.resolve();
    const second = await f.request();
    expect(second).toHaveProperty("error");
    await f.finish();
    expect(f.records.has(id)).toBe(true);
    expect(f.items.has("a")).toBe(true);
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
    expect(f.records.size).toBe(0);
    expect(f.person.email).toBe(deletedEmail);
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

  test("drops an expired intent for an enabled account without changing the account or its data", async () => {
    const f = fixture();
    f.record();
    f.items.set("a", f.row("a"));
    await f.finish();
    expect(f.person.status).toBe(true);
    expect(f.items.size).toBe(1);
    expect(f.records.size).toBe(0);
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
    expect(f.records.size).toBe(0);
  });

  test("when queuing or blocking fails, reports that nothing was deleted", async () => {
    for (const step of ["failRecord", "failBlock"] as const) {
      const f = fixture();
      f.items.set("a", f.row("a"));
      f.flags[step] = true;
      expect(await f.request()).toEqual({ error: DELETION_NOT_STARTED });
      expect(f.person.status).toBe(true);
      expect(f.items.size).toBe(1);
      expect(f.person.email).toBe(email);
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
    expect(f.records.size).toBe(0);
  });
});
