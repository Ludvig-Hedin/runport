// Checks an app's pinned ids against what Railway reports. Pure, so tested.

export type PinnedIds = { slug: string; workspaceId: string; railwayProjectId: string; environmentId: string; serviceId: string };
export type PinProject = {
  id: string;
  name: string;
  environments: { id: string; name: string }[];
  services: { id: string; name: string }[];
  volumes: number;
};

const PLATFORM_PROJECTS = new Set(["runport", "runport-dashboard"]);

export function checkPins<P extends PinProject>(
  pins: PinnedIds,
  projects: P[],
  workspace: string,
  duplicates: Set<string>,
): { problem: string | null; project?: P; extras: string[] } {
  if (duplicates.has(pins.slug)) return { problem: "Two entries claim the same project.", extras: [] };
  if (pins.workspaceId !== workspace) return { problem: "Pinned to another Railway workspace.", extras: [] };
  const project = projects.find((p) => p.id === pins.railwayProjectId);
  if (!project) return { problem: "Its Railway project is gone.", extras: [] };
  if (PLATFORM_PROJECTS.has(project.name) || project.name !== `${pins.slug}-app`) return { problem: "Its Railway project has an unexpected name.", extras: [] };
  const env = project.environments.find((e) => e.id === pins.environmentId);
  const web = project.services.find((s) => s.id === pins.serviceId);
  if (!env || env.name !== "production" || !web || web.name !== "web") return { problem: "Its Railway service no longer matches.", extras: [] };
  const extras = [
    ...(project.services.length > 1 ? [`${project.services.length - 1} other Railway service(s)`] : []),
    ...(project.environments.length > 1 ? [`${project.environments.length - 1} other Railway environment(s)`] : []),
    ...(project.volumes ? [`${project.volumes} Railway volume(s)`] : []),
  ];
  return { problem: null, project, extras };
}

/** Slugs whose Railway or Appwrite project id is also claimed by another entry. */
export function duplicateSlugs(pins: { slug: string; railwayProjectId: string; appwriteProjectId: string }[]): Set<string> {
  const seen = new Map<string, string[]>();
  for (const p of pins) for (const id of [`r:${p.railwayProjectId}`, `a:${p.appwriteProjectId}`]) seen.set(id, [...(seen.get(id) ?? []), p.slug]);
  return new Set([...seen.values()].filter((s) => s.length > 1).flat());
}
