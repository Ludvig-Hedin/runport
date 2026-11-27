import { describe, expect, test } from "bun:test";
import { contactFields, validateFields, looksLikeSpam } from "../lib/form-fields";
import { issueFormToken, verifyFormToken } from "../lib/form-token";
import { publicPagePath, sitemapEntries, siteOrigin } from "../lib/seo-paths";
import { indexingAllowed } from "../lib/config";

describe("form validation", () => {
  test("accepts a normal message with a link and normalizes the email", () => {
    const data = new FormData();
    data.set("name", "  Ada ");
    data.set("email", "Ada@Example.com");
    data.set("message", "Could you take a look at https://example.com?");
    const { values, errors } = validateFields(contactFields, data);
    expect(errors).toEqual({});
    expect(values.email).toBe("ada@example.com");
    expect(values.name).toBe("Ada");
    expect(looksLikeSpam("", Object.values(values))).toBe(false);
  });

  test("rejects missing or malformed values and ignores unregistered fields", () => {
    const data = new FormData();
    data.set("email", "bad");
    data.set("recipient", "visitor@example.com");
    const { values, errors } = validateFields(contactFields, data);
    expect(Object.keys(errors)).toEqual(["name", "email", "message"]);
    expect(values.recipient).toBeUndefined();
  });

  test("recognizes a filled honeypot, link floods and repeated characters", () => {
    expect(looksLikeSpam("filled", ["Hello"])).toBe(true);
    expect(looksLikeSpam("", ["https://a.com https://b.com https://c.com https://d.com"])).toBe(true);
    expect(looksLikeSpam("", ["xxxxxxxxxxxxxxxxxxxxxxxxx"])).toBe(true);
  });

  test("enforces server-issued timing and binds the timestamp to a form", () => {
    const token = issueFormToken("contact", "test-secret", 10000);
    expect(verifyFormToken(token, "contact", "test-secret", 10500)).toBe(false);
    expect(verifyFormToken(token, "contact", "test-secret", 12500)).toBe(true);
    expect(verifyFormToken(token, "other", "test-secret", 12500)).toBe(false);
    expect(verifyFormToken(token.replace(/^10000/, "1"), "contact", "test-secret", 12500)).toBe(false);
    expect(verifyFormToken(token, "contact", "test-secret", 10000 + 86400001)).toBe(false);
  });
});

describe("public URLs", () => {
  test("discovers only static pages marked public", () => {
    expect(publicPagePath("(public)/page.tsx")).toBe("/");
    expect(publicPagePath("(site)/(public)/about/page.mdx")).toBe("/about");
    expect(publicPagePath("(public)/blog/[slug]/page.tsx")).toBeNull();
    expect(publicPagePath("(public)/@modal/page.tsx")).toBeNull();
    expect(publicPagePath("items/page.tsx")).toBeNull();
    expect(publicPagePath("(public)/.hidden/page.tsx")).toBeNull();
  });

  test("deduplicates routes, keeps timestamps, and rejects noncanonical paths", () => {
    const origin = siteOrigin("https://example.com/");
    expect(sitemapEntries(origin, ["/", "/about", "/about/"], [
      { path: "/about", lastModified: "2026-11-27" },
      { path: "/blog/caf%C3%A9" },
      { path: "//other.example" },
      { path: "/about?preview=1" },
      { path: "/%2e%2e/login" },
    ])).toEqual([
      { url: "https://example.com/" },
      { url: "https://example.com/about", lastModified: "2026-11-27" },
      { url: "https://example.com/blog/caf%C3%A9" },
    ]);
  });

  test("requires an explicit switch and blocks previews and locked sites", () => {
    expect(indexingAllowed({})).toBe(false);
    expect(indexingAllowed({ ALLOW_INDEXING: "1" })).toBe(true);
    expect(indexingAllowed({ ALLOW_INDEXING: "1", RAILWAY_ENVIRONMENT_NAME: "production" })).toBe(true);
    expect(indexingAllowed({ ALLOW_INDEXING: "1", RAILWAY_ENVIRONMENT_NAME: "preview" })).toBe(false);
    expect(indexingAllowed({ ALLOW_INDEXING: "1", VERCEL_ENV: "preview" })).toBe(false);
    expect(indexingAllowed({ ALLOW_INDEXING: "1", SITE_PASSWORD: "test" })).toBe(false);
  });
});
