import { expect, test } from "bun:test";
import { buildClientSchema, parse, validate, type IntrospectionQuery } from "graphql";
import { checkApp } from "../app-alert-monitor";

// Versioned upstream contract. Set RAILWAY_CLI_SCHEMA to the downloaded
// railwayapp/cli src/gql/schema.json to run this check without network I/O.
const schemaPath = process.env.RAILWAY_CLI_SCHEMA;

test.skipIf(!schemaPath)("monitor queries validate against Railway's published CLI schema", async () => {
  const input = await Bun.file(schemaPath!).json() as { data: IntrospectionQuery };
  const schema = buildClientSchema(input.data);
  const queries: string[] = [];
  await checkApp({
    slug: "contract-test", registrationId: "fixture-registration", projectId: "fixture-project", serviceId: "fixture-service",
    environmentId: "fixture-environment", domain: "fixture.up.railway.app", incident: null,
  }, "fixture-token", async (_url, request) => {
    queries.push(JSON.parse(String(request?.body)).query);
    return Response.json({ data: { environment: { deletedAt: null, serviceInstances: {
      edges: [], pageInfo: { hasNextPage: false, endCursor: null },
    } } } });
  });
  expect(queries.length).toBeGreaterThan(0);
  for (const query of queries) expect(validate(schema, parse(query)).map((error) => error.message)).toEqual([]);
});
