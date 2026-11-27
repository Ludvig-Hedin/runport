// Choose only routes and event properties that are safe to store. A dynamic
// segment is recorded as its bracketed template, never as the visitor's value.
export const analyticsPolicy: {
  routes: readonly string[];
  events: Readonly<Record<string, Readonly<Record<string, readonly (string | number | boolean)[]>>>>;
} = {
  routes: ["/", "/login", "/signup", "/items"],
  events: {},
};

export function analyticsRoute(path: string, routes = analyticsPolicy.routes): string | undefined {
  const segments = path.split("/");
  return routes.find((route) => {
    const template = route.split("/");
    return template.length === segments.length && template.every((part, index) =>
      part === segments[index] || (/^\[[A-Za-z][A-Za-z0-9_]*\]$/.test(part) && !!segments[index]),
    );
  });
}
