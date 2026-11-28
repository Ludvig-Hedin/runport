import { resumeApp } from "@/lib/server/app-ops";
import { errorMessage, guardAction } from "@/lib/server/guard";

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const guard = await guardAction(request, (await params).slug);
  if ("response" in guard) return guard.response;
  try {
    await resumeApp(guard.app);
    return Response.json({ status: "deploying" });
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 502 });
  }
}
