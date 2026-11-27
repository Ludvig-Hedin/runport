import { ID } from "node-appwrite";
import { createAdminClient } from "@/lib/appwrite";
import { DATABASE_ID } from "@/lib/schema";
import { backupApp } from "@/lib/server/app-data";
import { deleteAppwriteProject, projectNames } from "@/lib/server/appwrite-console";
import { errorMessage, guardAction } from "@/lib/server/guard";
import { deleteProject } from "@/lib/server/railway";

// Deletes an app in visible steps and streams each one as a JSON line:
// backup → check → delete data → remove hosting → done. Nothing is deleted
// unless the backup was read back and matched.

export const maxDuration = 300;

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const guard = await guardAction(request, (await params).slug);
  if ("response" in guard) return guard.response;
  const { app } = guard;
  const body = (await request.json().catch(() => ({}))) as { confirm?: string };
  const names = await projectNames().catch(() => null);
  if (!names) return Response.json({ error: "Couldn’t reach Appwrite. Nothing was deleted." }, { status: 502 });
  const name = names.get(app.slug) ?? app.slug;
  // A delete that stopped after the data step leaves only the hosting. Then
  // there is nothing left to back up, and the retry finishes the job.
  const dataGone = !names.has(app.slug);
  if ((body.confirm ?? "").trim().toLowerCase() !== name.trim().toLowerCase()) {
    return Response.json({ error: `Type ${name} to confirm.` }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      let step = "backup";
      try {
        let backup: { name: string; inventory: unknown } = { name: "made earlier", inventory: null };
        if (!dataGone) {
          send({ step: "backup" });
          backup = await backupApp(app, (s) => send({ step: s === "check" ? "check" : "backup", detail: s }));
          step = "data";
          send({ step: "data" });
          await deleteAppwriteProject(app.slug);
        }
        step = "hosting";
        send({ step: "hosting" });
        await deleteProject(app);
        const { tables } = createAdminClient();
        await tables
          .createRow({ databaseId: DATABASE_ID, tableId: "deletions", rowId: ID.unique(), data: { slug: app.slug, name, backup: backup.name, counts: JSON.stringify(backup.inventory) } })
          .catch(() => {});
        send({ step: "done", backup: backup.name, inventory: backup.inventory });
      } catch (error) {
        send({ step: "error", failedAt: step, error: errorMessage(error), deleted: step !== "backup" });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
