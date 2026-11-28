import { expect, test } from "bun:test";
import { checkPins, duplicateSlugs } from "../lib/ops/pins";

const project = (over = {}) => ({
  id: "rp1", name: "fixture-app", volumes: 0,
  environments: [{ id: "env1", name: "production" }],
  services: [{ id: "svc1", name: "web" }],
  ...over,
});
const pins = { slug: "fixture", workspaceId: "ws", railwayProjectId: "rp1", environmentId: "env1", serviceId: "svc1" };

test("matching pins are verified", () => {
  expect(checkPins(pins, [project()], "ws", new Set())).toMatchObject({ problem: null, extras: [] });
});

test("a renamed, missing, foreign or platform project is refused", () => {
  expect(checkPins(pins, [project({ name: "Weblab" })], "ws", new Set()).problem).toContain("unexpected name");
  expect(checkPins(pins, [project({ name: "runport" })], "ws", new Set()).problem).toContain("unexpected name");
  expect(checkPins(pins, [], "ws", new Set()).problem).toContain("gone");
  expect(checkPins(pins, [project()], "other-ws", new Set()).problem).toContain("another Railway workspace");
  expect(checkPins({ ...pins, serviceId: "x" }, [project()], "ws", new Set()).problem).toContain("no longer matches");
  expect(checkPins(pins, [project({ environments: [{ id: "env1", name: "staging" }] })], "ws", new Set()).problem).toContain("no longer matches");
});

test("duplicate claims on one project block both entries", () => {
  const dup = duplicateSlugs([
    { slug: "a", railwayProjectId: "rp1", appwriteProjectId: "a" },
    { slug: "b", railwayProjectId: "rp1", appwriteProjectId: "b" },
    { slug: "c", railwayProjectId: "rp3", appwriteProjectId: "c" },
  ]);
  expect([...dup].sort()).toEqual(["a", "b"]);
  expect(checkPins({ ...pins, slug: "a" }, [project()], "ws", dup).problem).toContain("same project");
});

test("other services, environments and volumes are listed so a delete can refuse", () => {
  const extra = checkPins(pins, [project({ services: [{ id: "svc1", name: "web" }, { id: "w2", name: "worker" }], volumes: 1 })], "ws", new Set());
  expect(extra.problem).toBeNull();
  expect(extra.extras).toEqual(["1 other Railway service(s)", "1 Railway volume(s)"]);
});
