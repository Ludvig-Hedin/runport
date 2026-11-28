import { railwayApi } from "./railway-api";

type Project = { projectId: string; workspaceId: string };
export type RailwayWebhook = Project & { id: string };
type Rule = { id: string; projectId: string | null; eventTypes: string[];
  channels: Array<{ config: { type?: string; url?: string; headers?: Record<string, unknown> } }> };
const events = ["Deployment.crashed", "Deployment.failed", "Deployment.removed", "Deployment.deployed", "Deployment.restarted"];

async function findRules(project: Project, url: string): Promise<Rule[]> {
  const { notificationRules } = await railwayApi<{ notificationRules: Rule[] }>(
    `query($projectId: String, $workspaceId: String!) {
      notificationRules(projectId: $projectId, workspaceId: $workspaceId) { id projectId eventTypes channels { config } }
    }`, project,
  );
  return notificationRules.filter(rule => {
    const channel = rule.channels[0]?.config;
    return rule.projectId === project.projectId && rule.channels.length === 1 && channel?.type === "webhook" && channel.url === url;
  });
}

export async function ensureRailwayWebhook(project: Project, url: string, secret: string): Promise<RailwayWebhook> {
  const existing = await findRules(project, url);
  if (existing.length) {
    // Railway's CLI login can create and list rules but cannot edit them.
    // The URL identifies this exact desired configuration, including its key.
    const rule = existing.find(candidate => candidate.eventTypes.length === events.length &&
      events.every(event => candidate.eventTypes.includes(event)) &&
      Object.keys(candidate.channels[0]?.config.headers ?? {}).some(name => name.toLowerCase() === "authorization"));
    if (!rule) throw new Error("The existing Railway app webhook does not match its expected configuration.");
    return { ...project, id: rule.id };
  }
  const input = {
    eventTypes: events,
    ephemeralEnvironments: false,
    channelConfigs: [{ type: "webhook", url, headers: { Authorization: `Bearer ${secret}` } }],
  };
  const { notificationRuleCreate } = await railwayApi<{ notificationRuleCreate: { id: string } }>(
    `mutation($input: CreateNotificationRuleInput!) { notificationRuleCreate(input: $input) { id } }`,
    { input: { ...project, ...input } },
  );
  if (!notificationRuleCreate?.id) throw new Error("Railway did not return the app webhook ID.");
  return { ...project, id: notificationRuleCreate.id };
}
