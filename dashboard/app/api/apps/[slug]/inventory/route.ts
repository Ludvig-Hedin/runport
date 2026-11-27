import { inventory } from "@/lib/server/app-data";
import { errorMessage, guardAction } from "@/lib/server/guard";

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const guard = await guardAction(request, (await params).slug);
  if ("response" in guard) return guard.response;
  try {
    return Response.json(await inventory(guard.app));
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 502 });
  }
}
