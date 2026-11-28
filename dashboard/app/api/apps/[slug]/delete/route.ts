import { deleteDeps } from "@/lib/server/app-ops";
import { errorMessage, guardAction } from "@/lib/server/guard";
import { runDelete } from "@/lib/ops/delete-flow";

// Deletes an app in visible steps, streamed as JSON lines. The flow and its
// lock live in lib/ops/delete-flow.ts: nothing is deleted before a backup is
// verified byte for byte and its id is saved.

export const maxDuration = 300;

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const guard = await guardAction(request, (await params).slug);
  if ("response" in guard) return guard.response;
  const { app } = guard;
  const body = (await request.json().catch(() => ({}))) as { confirm?: string };
  if ((body.confirm ?? "").trim().toLowerCase() !== app.pins.name.trim().toLowerCase()) {
    return Response.json({ error: `Type ${app.pins.name} to confirm.` }, { status: 400 });
  }
  let deps;
  try {
    deps = deleteDeps(app);
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 409 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      let last = "stop";
      try {
        const record = await runDelete(app.pins.railwayProjectId, app.pins.slug, deps, (step) => {
          last = step;
          if (step !== "done") send({ step });
        });
        send({ step: "done", backup: record.backupName ?? "", inventory: record.counts ?? null });
      } catch (error) {
        send({ step: "error", failedAt: last, error: errorMessage(error), deleted: last === "data" || last === "hosting" });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
