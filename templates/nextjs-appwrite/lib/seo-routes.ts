import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { publicPagePath } from "./seo-paths";

export function discoverPublicPages(app: string): string[] {
  return readdirSync(app, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .flatMap((entry) => {
      const path = publicPagePath(relative(app, join(entry.parentPath, entry.name)).split(sep).join("/"));
      return path ? [path] : [];
    })
    .sort();
}
