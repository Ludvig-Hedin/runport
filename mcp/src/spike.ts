// Stage 1 spike: can the owner session create a project, a server key and a
// web platform on this Appwrite install? Creates a throwaway project and
// deletes it again. Run: bun run spike
import { AppwriteAdmin } from "./appwrite-admin";

const admin = new AppwriteAdmin();
const projectId = `spike-${Date.now().toString(36)}`;

async function step(label: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    console.log(`PASS ${label}${admin.lastRoute ? ` via ${admin.lastRoute}` : ""}`);
    return true;
  } catch (error) {
    console.log(`FAIL ${label}: ${error instanceof Error ? error.message : error}`);
    return false;
  } finally {
    admin.lastRoute = null;
  }
}

if (!(await admin.health())) {
  console.log("FAIL Appwrite is not reachable");
  process.exit(1);
}
const created = await step("create project", () => admin.createProject(projectId, "Spike test"));
if (created) {
  await step("create server key", () => admin.createServerKey(projectId, "spike-key"));
  await step("add web platform localhost", () => admin.addWebPlatform(projectId, "localhost"));
  await step("delete project", () => admin.deleteProject(projectId));
}
