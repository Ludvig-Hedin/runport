import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionAppAnalytics } from "../src/analytics-integration";

test("an existing layout without the starter routes never gets analytics variables", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runport-test-analytics-"));
  try {
    await mkdir(join(dir, "app"));
    await writeFile(join(dir, "app", "layout.tsx"), "export default function Layout() { return <VisitorAnalytics />; }");
    const result = await provisionAppAnalytics(dir, "legacy-fixture", "example.net");
    expect(result.variables).toEqual({});
    expect(result.note).toContain("skipped");
  } finally {
    await rm(dir, { recursive: true });
  }
});
