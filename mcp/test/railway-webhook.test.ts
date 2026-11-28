import { expect, test } from "bun:test";
import { ensureRailwayWebhook } from "../src/railway-webhook";

test("Railway provisioning reuses the app-specific rule and suppresses provider error details", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.RAILWAY_API_TOKEN;
  const project = { projectId: "fixture-project", workspaceId: "fixture-workspace" };
  const url = "https://gateway.example.invalid/_runport/alerts/railway/fixture";
  const secret = "isolated-header-secret";
  const eventTypes = ["Deployment.crashed", "Deployment.failed", "Deployment.removed", "Deployment.deployed", "Deployment.restarted"];
  const rule = { id: "fixture-rule", projectId: project.projectId, eventTypes,
    channels: [{ config: { type: "webhook", url, headers: { Authorization: null } } }] };
  let created = false;
  let deny = false;
  let mutations = 0;
  try {
    process.env.RAILWAY_API_TOKEN = "isolated-cli-credential";
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(input)).toBe("https://backboard.railway.com/graphql/v2");
      const { query, variables } = JSON.parse(String(init?.body));
      if (query.includes("notificationRules")) {
        return Response.json({ data: { notificationRules: created ? [rule] : [{ ...rule, projectId: "different-project" }] } });
      }
      expect(query).toContain("notificationRuleCreate");
      expect(variables.input.channelConfigs[0].headers.Authorization).toBe(`Bearer ${secret}`);
      mutations++;
      if (deny) return Response.json({ errors: [{ message: `Provider echoed ${secret}` }] });
      created = true;
      return Response.json({ data: { notificationRuleCreate: { id: rule.id } } });
    }, { preconnect: originalFetch.preconnect });
    expect(await ensureRailwayWebhook(project, url, secret)).toEqual({ ...project, id: rule.id });
    expect(await ensureRailwayWebhook(project, url, secret)).toEqual({ ...project, id: rule.id });
    expect(mutations).toBe(1);
    created = false;
    deny = true;
    const refusal = await ensureRailwayWebhook(project, url, secret).catch((error: Error) => error.message);
    expect(refusal).toBe("Railway API refused the request (200).");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.RAILWAY_API_TOKEN;
    else process.env.RAILWAY_API_TOKEN = originalToken;
  }
});
