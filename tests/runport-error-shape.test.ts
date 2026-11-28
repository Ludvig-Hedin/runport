import { expect, test } from "bun:test";
import { errorReport } from "../templates/nextjs-appwrite/lib/error-shape";

test("uses only fixed labels and a code location, independent of error text and request data", async () => {
  const frame = "    at save (.next/server/app/items/page.js:7:11)";
  const first = await errorReport("action", "TypeError", "TypeError: alice@example.test Cookie: session=abc\n" + frame, "/items/[id]");
  const second = await errorReport("action", "TypeError", "TypeError: Bearer abc https://x/?token=def\n" + frame, "/items/[id]");
  expect(first).toEqual(second);
  expect(first).toEqual({ source: "action", kind: "TypeError", fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
  const changed = await errorReport("action", "TypeError", frame.replace(":7:", ":8:"), "/items/[id]");
  expect(changed.fingerprint).not.toBe(first.fingerprint);
});

test("drops cross-origin browser frames and arbitrary exception names", async () => {
  const first = await errorReport("browser", "secret@example.test", " at https://other.test/_next/static/chunks/abc.js:1:2", "", "https://app.test");
  const second = await errorReport("browser", "anything", "", "", "https://app.test");
  expect(first).toEqual(second);
  expect(first.kind).toBe("Error");
});
