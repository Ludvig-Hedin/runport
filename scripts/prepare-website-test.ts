import { cp, mkdir, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

// A disposable website made from the real starter. No backend or hosting
// resources are created. Install packages in the returned folder before use.
const root = resolve(import.meta.dir, "..");
const folder = join(root, ".scratch", "website-test");
if (await stat(folder).catch(() => null)) {
  throw new Error(`${folder} already exists. Keep or remove that test copy explicitly.`);
}
const skip = new Set(["node_modules", ".next", ".env.local", ".mcp.json", "next-env.d.ts", "tsconfig.tsbuildinfo"]);
await mkdir(folder, { recursive: true });
await cp(join(root, "templates", "nextjs-appwrite"), folder, {
  recursive: true,
  filter: (path) => !skip.has(basename(path)),
});
await cp(join(root, "examples", "website"), folder, { recursive: true });
await writeFile(join(folder, ".env.local"), "APPWRITE_PROJECT_ID=website-test\nPORT=3112\n", { mode: 0o600 });
console.log(folder);
