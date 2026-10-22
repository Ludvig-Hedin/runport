import { describe, expect, test } from "bun:test";
import { nextFreePort, type AppRecord } from "../src/registry";
import { isValidSlug, toSlug } from "../src/slug";

describe("toSlug", () => {
  test("lowercases and joins words with hyphens", () => {
    expect(toSlug("Todo List")).toBe("todo-list");
  });

  test("drops accents and symbols", () => {
    expect(toSlug("Kåre's Café & Bar!")).toBe("kare-s-cafe-bar");
  });

  test("caps length at 36 without a trailing hyphen", () => {
    const slug = toSlug("a very long application name that keeps going and going");
    expect(slug.length).toBeLessThanOrEqual(36);
    expect(slug.endsWith("-")).toBe(false);
  });

  test("rejects names that cannot start with a letter", () => {
    expect(() => toSlug("123")).toThrow();
    expect(() => toSlug("!!")).toThrow();
  });
});

describe("isValidSlug", () => {
  test("accepts normal ids and rejects bad ones", () => {
    expect(isValidSlug("todo-list")).toBe(true);
    expect(isValidSlug("Todo")).toBe(false);
    expect(isValidSlug("a--b")).toBe(false);
    expect(isValidSlug("-a")).toBe(false);
  });
});

describe("nextFreePort", () => {
  const app = (port: number) => ({ port }) as AppRecord;

  test("starts at the first port and skips used ones", () => {
    expect(nextFreePort([])).toBe(3101);
    expect(nextFreePort([app(3101), app(3102)])).toBe(3103);
    expect(nextFreePort([app(3102)])).toBe(3101);
  });
});
