const extensions = { appwrite: "dump", analytics: "dump", git: "tar.gz" } as const;
export type ArchiveKind = keyof typeof extensions;

export function archiveKey(kind: ArchiveKind, day: string): string {
  return `backups/${kind}-${day}.${extensions[kind]}`;
}

export function expiredArchives(keys: string[], kind: ArchiveKind, cutoff: number, verified: string): string[] {
  const archives = keys.flatMap((key) => {
    const day = key.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    if (!day || archiveKey(kind, day) !== key) return [];
    const date = Date.parse(day);
    if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== day) return [];
    return [{ key, date }];
  }).sort((a, b) => b.date - a.date);
  return archives.slice(1).filter(({ key, date }) => key !== verified && date < cutoff).map(({ key }) => key);
}

export async function finishArchive(upload: () => Promise<void>, prune: () => Promise<void>): Promise<void> {
  await upload();
  await prune();
}

export async function writeVerifiedArchive(
  archive: Blob,
  destination: { write(data: Blob): Promise<unknown>; stat(): Promise<{ size: number }> },
): Promise<number> {
  const bytes = archive.size;
  if (bytes < 1024) throw new Error(`Backup is only ${bytes} bytes.`);
  await destination.write(archive);
  const stored = (await destination.stat()).size;
  if (stored !== bytes) throw new Error(`Stored backup size did not verify (${stored} of ${bytes} bytes).`);
  return stored;
}
