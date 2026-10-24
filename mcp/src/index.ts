#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createApp, deleteApp, listApps } from "./apps";
import { logAction } from "./log";

const server = new McpServer({ name: "runport", version: "0.1.0" });

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Runs a tool body, logs the call and turns failures into readable tool errors. */
async function handle(tool: string, detail: Record<string, unknown>, body: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const result = await body();
    await logAction(tool, { ...detail, ok: true });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logAction(tool, { ...detail, ok: false, error: message });
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

server.registerTool(
  "create_app",
  {
    title: "Create app",
    description:
      "Creates a new app on the self-hosted platform: an Appwrite project (accounts, database, files), a Next.js starter " +
      "with sign-up and login in ~/Programming/apps/<id>, its tables, and a private GitHub repo. Safe to call again with " +
      "the same name to resume after a failure. Afterwards, build features in the returned folder and read its CLAUDE.md.",
    inputSchema: {
      name: z.string().min(2).max(60).describe("Human name of the app, for example 'Todo list'."),
      projectId: z.string().optional().describe("Only if told to: an Appwrite project that already exists."),
      apiKey: z.string().optional().describe("Only together with projectId: that project's server key."),
    },
  },
  async ({ name, projectId, apiKey }) => handle("create_app", { name, projectId }, () => createApp({ name, projectId, apiKey })),
);

server.registerTool(
  "list_apps",
  {
    title: "List apps",
    description: "Lists every app the platform created, with folder, local URL port, repo and Appwrite project id.",
    annotations: { readOnlyHint: true },
  },
  async () => handle("list_apps", {}, listApps),
);

server.registerTool(
  "delete_app",
  {
    title: "Delete app",
    description:
      "Permanently deletes an app's Appwrite project, including all its users and data. Ask the owner first. " +
      "The local folder is removed only if all work is committed and pushed. The GitHub repo is never deleted.",
    inputSchema: {
      id: z.string().describe("The app id from list_apps."),
      confirm: z.string().describe("Must equal the app id. Only pass it after the owner said yes."),
    },
    annotations: { destructiveHint: true },
  },
  async ({ id, confirm }) => handle("delete_app", { id }, () => deleteApp(id, confirm)),
);

await server.connect(new StdioServerTransport());
