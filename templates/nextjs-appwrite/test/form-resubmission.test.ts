import { expect, mock, spyOn, test } from "bun:test";
import { contactFields } from "../lib/form-fields";
import { issueFormToken } from "../lib/form-token";

const key = "test-form-token-key";
const rows = new Map<string, { payload: string }>();
mock.module("server-only", () => ({}));
mock.module("@/lib/appwrite", () => ({
  config: { apiKey: () => key },
  createAdminClient: () => ({
    tables: {
      createRow: async ({ rowId, data }: { rowId: string; data: { payload: string } }) => {
        if (rows.has(rowId)) throw new Error("A form used an already-saved token");
        rows.set(rowId, data);
      },
      updateRow: async () => {},
    },
  }),
}));
mock.module("@/lib/rate-limit", () => ({ allowed: async () => true, take: () => true }));

test("saving, rejecting and correcting a second message saves it separately", async () => {
  const { submitForm } = await import("../lib/form-submission");
  let now = 1710000000000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const owner = process.env.RUNPORT_FORM_OWNER_EMAIL;
  delete process.env.RUNPORT_FORM_OWNER_EMAIL;
  try {
    const form = (token: string, email: string, message: string) => {
      const data = new FormData();
      data.set("_rp_token", token);
      data.set("name", "Example Visitor");
      data.set("email", email);
      data.set("message", message);
      return data;
    };
    const initial = issueFormToken("contact", key, now - 2000);
    const first = await submitForm("contact", contactFields, form(initial, "visitor@example.invalid", "First message"));
    expect(first.status).toBe("success");
    expect(first.token).not.toBe(initial);

    now += 2000;
    const rejected = await submitForm("contact", contactFields, form(first.token, "bad-email", "Second message"));
    expect(rejected.errors?.email).toBeDefined();
    expect(rejected.token).not.toBe(initial);
    expect(rejected.token).not.toBe(first.token);
    expect(rows.size).toBe(1);

    const second = await submitForm("contact", contactFields, form(rejected.token, "visitor@example.invalid", "Second message"));
    expect(second.status).toBe("success");
    expect(rows.size).toBe(2);
    expect([...rows.values()].map(({ payload }) => JSON.parse(payload).message)).toEqual(["First message", "Second message"]);
  } finally {
    if (owner !== undefined) process.env.RUNPORT_FORM_OWNER_EMAIL = owner;
    clock.mockRestore();
  }
});
