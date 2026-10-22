/**
 * Turns a human app name into a slug that is valid as a folder name, a GitHub
 * repo name and an Appwrite project id (max 36 chars, a-z 0-9 and hyphens,
 * starting with a letter).
 */
export function toSlug(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
    .replace(/-+$/g, "");
  if (!isValidSlug(slug)) {
    throw new Error(`Cannot make a valid app id from "${name}". Use letters and numbers, starting with a letter.`);
  }
  return slug;
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z][a-z0-9-]{1,35}$/.test(slug) && !slug.endsWith("-") && !slug.includes("--");
}

/** Appwrite's own id rule: up to 36 chars of a-z A-Z 0-9 . - _, not starting with a symbol. */
export function assertAppwriteId(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/.test(id)) throw new Error(`"${id}" is not a valid Appwrite project id.`);
  return id;
}
