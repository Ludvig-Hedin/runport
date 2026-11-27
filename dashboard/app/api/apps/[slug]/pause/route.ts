import { errorMessage, guardAction } from "@/lib/server/guard";
import { pauseApp } from "@/lib/server/railway";

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const guard = await guardAction(request, (await params).slug);
  if ("response" in guard) return guard.response;
  try {
    await pauseApp(guard.app);
    return Response.json({ status: "paused" });
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 502 });
  }
}
