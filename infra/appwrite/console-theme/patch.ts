// Swaps the Appwrite pinks for blue and the blue-tinted dark greys for
// neutral ones in the built admin, then appends theme.css to the main
// stylesheet. Usage: bun patch.ts <dist folder>
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

const root = process.argv[2];
if (!root) throw new Error("Usage: bun patch.ts <dist folder>");

const BLUE = "3366ff";
const BLUE_DEEP = "2455e6";

const hex: Record<string, string> = {
  // Brand pinks.
  fd366e: BLUE,
  f02e65: BLUE_DEEP,
  // Dark greys with a blue tint, mapped to neutral greys of the same lightness.
  "09090b": "0a0a0a",
  "0d0d10": "0e0e0e",
  "131316": "141414",
  "141416": "151515",
  "17171c": "181818",
  "18181b": "181818",
  "19191c": "1a1a1a",
  "19191d": "1a1a1a",
  "1d1d21": "1e1e1e",
  "212126": "222222",
  "222224": "222222",
  "27272a": "282828",
  "2c2c33": "2e2e2e",
  "2d2d31": "2e2e2e",
  "3f3f46": "414141",
};
const hexPattern = new RegExp(`#(${Object.keys(hex).join("|")})(?=(?:[0-9a-f]{2})?(?![0-9a-f]))`, "gi");

const rgb: [RegExp, string][] = [
  [/\b253, ?54, ?110\b/g, "51, 102, 255"],
  [/\b240, ?46, ?101\b/g, "36, 85, 230"],
];

const PATCHED = /\.(js|mjs|css|html|svg|json)$/;

async function* files(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (PATCHED.test(entry.name)) yield path;
  }
}

const all: string[] = [];
for await (const path of files(root)) all.push(path);

let changed = 0;
let mainCss: string | null = null;
for (const path of all) {
  const before = await readFile(path, "utf8");
  let after = before.replace(hexPattern, (m, h: string) => {
    const to = hex[h.toLowerCase()];
    return `#${h === h.toUpperCase() ? to.toUpperCase() : to}`;
  });
  for (const [from, to] of rgb) after = after.replace(from, to);
  if (path.endsWith(".css") && after.includes("--brand-cta")) mainCss = path;
  if (after !== before) {
    await writeFile(path, after);
    changed++;
  }
}
if (!mainCss) throw new Error("Main stylesheet not found; the console build changed.");
const theme = await readFile(join(import.meta.dir, "theme.css"), "utf8");
await writeFile(mainCss, (await readFile(mainCss, "utf8")) + theme);

// Assets are served as immutable for a year, so browsers keep old colours
// unless the names change. Give every script and stylesheet a new name tied
// to this theme, then rewrite references in one pass.
const tag = new Bun.CryptoHasher("sha256")
  .update(await readFile(import.meta.path, "utf8"))
  .update(theme)
  .digest("hex")
  .slice(0, 8);
const assetDir = join(root, "client", "assets");
const names = new Map<string, string>();
for (const name of await readdir(assetDir)) {
  const ext = extname(name);
  if (ext !== ".js" && ext !== ".css") continue;
  const next = `${basename(name, ext)}.${tag}${ext}`;
  await rename(join(assetDir, name), join(assetDir, next));
  names.set(name, next);
}
const assetName = /[A-Za-z0-9_.$~-]+\.(?:js|css)\b/g;
let rewritten = 0;
for (const old of all) {
  const path = names.has(basename(old)) && dirname(old) === assetDir ? join(assetDir, names.get(basename(old))!) : old;
  const before = await readFile(path, "utf8");
  const after = before.replace(assetName, (m) => names.get(m) ?? m);
  if (after !== before) {
    await writeFile(path, after);
    rewritten++;
  }
}
console.log(`patched ${changed} files, theme appended to ${basename(mainCss)}, renamed ${names.size} assets, rewrote ${rewritten} references`);
