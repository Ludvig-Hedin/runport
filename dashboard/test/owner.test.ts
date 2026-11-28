import { expect, test } from "bun:test";
import { accessFor, isOwnerEmail, ownerEmails } from "../lib/owner-rules";

const list = " Owner@Example.test , second@example.test ";

test("the allowlist is trimmed and case-insensitive", () => {
  expect(ownerEmails(list)).toEqual(["owner@example.test", "second@example.test"]);
  expect(isOwnerEmail("OWNER@example.test", list)).toBe(true);
  expect(isOwnerEmail("someone@example.test", list)).toBe(false);
});

test("an empty or missing list lets nobody in", () => {
  expect(accessFor({ email: "owner@example.test", emailVerification: true }, "")).toBe("no-access");
  expect(accessFor({ email: "owner@example.test", emailVerification: true }, undefined)).toBe("no-access");
});

test("only a verified owner email is the owner", () => {
  expect(accessFor(null, list)).toBe("signed-out");
  expect(accessFor({ email: "owner@example.test", emailVerification: true }, list)).toBe("owner");
  expect(accessFor({ email: "owner@example.test", emailVerification: false }, list)).toBe("no-access");
  expect(accessFor({ email: "stranger@example.test", emailVerification: true }, list)).toBe("no-access");
  expect(accessFor({ email: "owner@example.test.evil", emailVerification: true }, list)).toBe("no-access");
});
