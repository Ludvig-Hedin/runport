import { consumeFlash } from "@/lib/flash";

export async function POST() {
  return Response.json({ notice: await consumeFlash() }, {
    headers: { "Cache-Control": "no-store" },
  });
}
