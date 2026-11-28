// A tiny Appwrite REST client keyed to one project. Plain fetch, so it runs
// the same in the dashboard (Node) and in the Mac tools and tests (Bun).
// It returns raw bytes for downloads: the SDK parses JSON files into objects,
// which would break a byte-for-byte backup.

export type AppwriteApi = {
  project: string;
  get<T>(path: string): Promise<T>;
  send<T>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T>;
  download(bucketId: string, fileId: string): Promise<Uint8Array>;
  upload(bucketId: string, fileId: string, name: string, bytes: Uint8Array, permissions?: string[]): Promise<{ $id: string; sizeOriginal: number }>;
};

export class AppwriteHttpError extends Error {
  constructor(readonly status: number, readonly type: string | undefined, readonly path: string) {
    // Only the method-free path and status: Appwrite messages can echo input.
    super(`Appwrite answered ${status} for ${path.split("?")[0]}`);
  }
}

/** Appwrite's upload chunk size. Larger files go up in pieces with Content-Range. */
const CHUNK = 5 * 1024 * 1024;

export function appwriteApi(endpoint: string, project: string, key: string): AppwriteApi {
  const base = endpoint.replace(/\/+$/, "");
  const headers = { "X-Appwrite-Project": project, "X-Appwrite-Key": key };

  async function call<T>(method: string, path: string, body?: unknown, extra?: Record<string, string>, form?: FormData): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...headers, ...(form ? {} : { "Content-Type": "application/json" }), ...extra },
      body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { type?: string };
      throw new AppwriteHttpError(res.status, err.type, path);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  return {
    project,
    get: (path) => call("GET", path),
    send: (method, path, body) => call(method, path, body),
    async download(bucketId, fileId) {
      const path = `/storage/buckets/${encodeURIComponent(bucketId)}/files/${encodeURIComponent(fileId)}/download`;
      const res = await fetch(`${base}${path}`, { headers, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(300_000) });
      if (!res.ok) throw new AppwriteHttpError(res.status, undefined, path);
      return new Uint8Array(await res.arrayBuffer());
    },
    async upload(bucketId, fileId, name, bytes, permissions) {
      const path = `/storage/buckets/${encodeURIComponent(bucketId)}/files`;
      let result: { $id: string; sizeOriginal: number } | undefined;
      for (let start = 0; start === 0 || start < bytes.length; start += CHUNK) {
        const end = Math.min(start + CHUNK, bytes.length);
        const form = new FormData();
        form.set("fileId", fileId);
        for (const p of permissions ?? []) form.append("permissions[]", p);
        form.set("file", new Blob([bytes.slice(start, end)]), name);
        const range = bytes.length > CHUNK ? { "Content-Range": `bytes ${start}-${Math.max(end - 1, 0)}/${bytes.length}`, ...(start > 0 ? { "X-Appwrite-ID": fileId } : {}) } : undefined;
        result = await call("POST", path, undefined, range, form);
        if (bytes.length === 0) break;
      }
      return result!;
    },
  };
}

/** Reads every page of a list, 100 at a time, by cursor. */
export async function listAll<T extends { $id: string }>(api: AppwriteApi, path: string, field: string): Promise<T[]> {
  const out: T[] = [];
  for (;;) {
    const queries = [JSON.stringify({ method: "limit", values: [100] })];
    if (out.length) queries.push(JSON.stringify({ method: "cursorAfter", values: [out[out.length - 1]!.$id] }));
    const qs = queries.map((q) => `queries[]=${encodeURIComponent(q)}`).join("&");
    const page = await api.get<Record<string, T[]>>(`${path}${path.includes("?") ? "&" : "?"}${qs}`);
    const items = page[field] ?? [];
    out.push(...items);
    if (items.length < 100) return out;
  }
}
