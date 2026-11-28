import { finishPendingDeletions } from "@/lib/account-deletion";
import { authorisedMaintenance } from "@/lib/account-maintenance";
import { createAdminClient } from "@/lib/appwrite";
import { take } from "@/lib/rate-limit";

let running = false;

export async function POST(request: Request) {
  if (!process.env.RUNPORT_ACCOUNT_MAINTENANCE_KEY) return new Response(null, { status: 404 });
  if (!authorisedMaintenance(request.headers.get("authorization"))) return new Response(null, { status: 401 });
  if (running || !take("account-maintenance", 2, 60_000)) return new Response(null, { status: 429 });

  running = true;
  try {
    const { failed } = await finishPendingDeletions(createAdminClient());
    return new Response(null, { status: failed ? 503 : 204 });
  } catch {
    console.error("Could not read the account deletion queue");
    return new Response(null, { status: 503 });
  } finally {
    running = false;
  }
}
