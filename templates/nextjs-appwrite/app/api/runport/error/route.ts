import { errorKinds } from "@/lib/error-shape";
import { errorReportingEnabled, sendErrorReport } from "@/lib/report-error";

export async function POST(request: Request) {
  if (!errorReportingEnabled()) return new Response(null, { status: 204 });
  if (request.headers.get("sec-fetch-site") !== "same-origin"
    || request.headers.get("content-type") !== "application/json") {
    return new Response(null, { status: 403 });
  }

  // The browser always sends a fixed-size JSON record. Bound the stream
  // independently of Content-Length, which a caller can omit.
  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400 });
  const bytes = new Uint8Array(512);
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (size + chunk.value.length > bytes.length) {
        void reader.cancel().catch(() => {});
        return new Response(null, { status: 413 });
      }
      bytes.set(chunk.value, size);
      size += chunk.value.length;
    }
    const payload = JSON.parse(new TextDecoder().decode(bytes.subarray(0, size)));
    const kind = errorKinds.find((known) => known === payload?.kind);
    const fingerprint = payload?.fingerprint;
    if (!kind || typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) {
      return new Response(null, { status: 400 });
    }
    await sendErrorReport({ source: "browser", kind, fingerprint });
    return new Response(null, { status: 204 });
  } catch {
    return new Response(null, { status: 400 });
  }
}
